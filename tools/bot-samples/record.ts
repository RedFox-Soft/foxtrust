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

const tools: Record<string, () => Promise<void>> = {
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
