/**
 * Records one automation sample for the bot-verdict labelled set (spec 007 research R8).
 * Development only: never imported by FoxTrust code and never installed in the image.
 *
 *   bun run record.ts --tool <name> [--url http://127.0.0.1:8795/]
 *
 * Start `foxtrust bot record --label <tool label> --kind automation` first; this script opens its page
 * with the named tool, in its stock headless configuration, and waits until the page says "Recorded".
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { tool: { type: "string" }, url: { type: "string" } } });
const url = values.url ?? "http://127.0.0.1:8795/";
const tool = values.tool ?? "";
const TIMEOUT = 30_000;

type Page = { goto(url: string): Promise<unknown>; waitForFunction(fn: () => boolean, opts?: object): Promise<unknown> };
const recorded = () => document.body.innerText.includes("Recorded");

async function viaPlaywright(engine: "chromium" | "firefox" | "webkit", pkg: "playwright" | "patchright") {
  const lib = (await import(pkg)) as unknown as Record<string, { launch(o: object): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }> }>;
  const browser = await lib[engine]!.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(recorded, { timeout: TIMEOUT });
  } finally {
    await browser.close();
  }
}

async function viaPuppeteer(stealth: boolean) {
  let launcher: { launch(o: object): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }> };
  if (stealth) {
    const extra = (await import("puppeteer-extra")).default as unknown as typeof launcher & { use(p: unknown): void };
    const plugin = (await import("puppeteer-extra-plugin-stealth")).default as unknown as () => unknown;
    extra.use(plugin());
    launcher = extra;
  } else {
    launcher = (await import("puppeteer")).default as unknown as typeof launcher;
  }
  const browser = await launcher.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(recorded, { timeout: TIMEOUT });
  } finally {
    await browser.close();
  }
}

/** Hold-step tools (spec 009 research R5): each scripts a 1-second press-and-hold of #foxtrust-hold. */
type HoldPage = Page & {
  waitForSelector(selector: string, opts?: object): Promise<{ boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> } | null>;
  mouse: { move(x: number, y: number, opts?: object): Promise<void>; down(): Promise<void>; up(): Promise<void> };
  keyboard: { down(key: string): Promise<void>; up(key: string): Promise<void> };
  focus(selector: string): Promise<void>;
};
const BUTTON = "#foxtrust-hold:not([disabled])";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function centre(page: HoldPage) {
  const handle = await page.waitForSelector(BUTTON, { timeout: TIMEOUT });
  const box = await handle!.boundingBox();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

async function holdWithPlaywright(how: "straight" | "key") {
  const lib = (await import("playwright")) as unknown as { chromium: { launch(o: object): Promise<{ newPage(): Promise<HoldPage>; close(): Promise<void> }> } };
  const browser = await lib.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    const c = await centre(page);
    if (how === "straight") {
      await page.mouse.move(c.x, c.y, { steps: 25 });
      await page.mouse.down();
      await sleep(1000);
      await page.mouse.up();
    } else {
      await page.focus(BUTTON);
      await page.keyboard.down("Space");
      await sleep(1000);
      await page.keyboard.up("Space");
    }
    await page.waitForFunction(recorded, { timeout: TIMEOUT });
  } finally {
    await browser.close();
  }
}

async function holdWithPuppeteer(how: "ghost" | "cdp", stealth: boolean) {
  let launcher: { launch(o: object): Promise<{ newPage(): Promise<HoldPage & { createCDPSession(): Promise<{ send(m: string, p: object): Promise<unknown> }> }>; close(): Promise<void> }> };
  if (stealth) {
    const extra = (await import("puppeteer-extra")).default as unknown as typeof launcher & { use(p: unknown): void };
    extra.use(((await import("puppeteer-extra-plugin-stealth")).default as unknown as () => unknown)());
    launcher = extra;
  } else {
    launcher = (await import("puppeteer")).default as unknown as typeof launcher;
  }
  const browser = await launcher.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    const c = await centre(page);
    if (how === "ghost") {
      // ghost-cursor drives the mouse through CDP itself, so press and release through it too.
      type Cursor = { move(sel: string): Promise<void>; mouseDown(): Promise<void>; mouseUp(): Promise<void> };
      const { createCursor } = (await import("ghost-cursor")) as unknown as { createCursor(p: unknown): Cursor };
      const cursor = createCursor(page);
      await cursor.move(BUTTON);
      await cursor.mouseDown();
      await sleep(1000);
      await cursor.mouseUp();
    } else {
      const cdp = await page.createCDPSession();
      const event = { x: c.x, y: c.y, button: "left", clickCount: 1 };
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...event });
      await sleep(1000);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...event });
    }
    await page.waitForFunction(recorded, { timeout: TIMEOUT });
  } finally {
    await browser.close();
  }
}

const tools: Record<string, () => Promise<void>> = {
  "hold-playwright-straight": () => holdWithPlaywright("straight"),
  "hold-key-script": () => holdWithPlaywright("key"),
  "hold-ghost-cursor": () => holdWithPuppeteer("ghost", false),
  "hold-cdp-direct": () => holdWithPuppeteer("cdp", false),
  "hold-stealth-ghost": () => holdWithPuppeteer("ghost", true),
  "playwright-chromium": () => viaPlaywright("chromium", "playwright"),
  "playwright-firefox": () => viaPlaywright("firefox", "playwright"),
  "playwright-webkit": () => viaPlaywright("webkit", "playwright"),
  patchright: () => viaPlaywright("chromium", "patchright"),
  puppeteer: () => viaPuppeteer(false),
  "puppeteer-stealth": () => viaPuppeteer(true),
};

const run = tools[tool];
if (!run) {
  console.error(`--tool must be one of: ${Object.keys(tools).join(", ")}`);
  process.exit(2);
}
await run();
console.log(`${tool}: recorded`);
