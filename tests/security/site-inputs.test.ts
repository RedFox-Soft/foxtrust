import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEEDS } from "../../src/feeds/registry";
import { DEFAULT_WIKI_ENTITIES, readLicence } from "../../src/ingest/licence-gate";
import { CONTENT_DIR } from "../../src/site/content";
import { startTestSite, type TestSite } from "../helpers/site";

const PUBLIC = ["/", "/dispute", "/docs/api", "/docs/snapshots", "/privacy", "/terms", "/nope"];

describe("SEC (spec 012): public pages", () => {
  let site: TestSite;

  beforeAll(async () => {
    site = await startTestSite();
  });

  afterAll(async () => {
    await site?.stop();
  });

  const get = async (path: string, at = site) => {
    const res = await fetch(`${at.url}${path}`, { redirect: "manual" });
    return { headers: res.headers, html: await res.text() };
  };

  test("SEC: public pages forbid framing and carry no script", async () => {
    for (const path of PUBLIC) {
      const { headers, html } = await get(path);
      expect({ path, csp: headers.get("content-security-policy"), frame: headers.get("x-frame-options") }).toEqual({
        path,
        csp: "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        frame: "DENY",
      });
      expect({ path, script: /<script/i.test(html), handler: /<[^>]*\son[a-z]+\s*=/i.test(html), inlineStyle: /\sstyle\s*=/i.test(html) })
        .toEqual({ path, script: false, handler: false, inlineStyle: false });
    }
  });

  test("SEC: raw HTML in content never reaches a page", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ft-site-content-"));
    try {
      await cp(CONTENT_DIR, dir, { recursive: true });
      await writeFile(join(dir, "landing.md"), [
        "# Landing", "", "<script>alert(1)</script>", "",
        'Text <img src=x onerror=alert(1)> and <a href="javascript:alert(1)">x</a>.', "",
        "[link](javascript:alert(1)) [mixed](JaVaScRiPt:alert(1)) [data](data:text/html,x) ![img](javascript:alert(1))", "",
      ].join("\n"));
      const hostile = await startTestSite({ contentDir: dir });
      try {
        const { html } = await get("/", hostile);
        expect({
          script: /<script/i.test(html),
          handler: /<img[^>]*onerror/i.test(html),
          scheme: /(?:href|src)="\s*(?:javascript|data):/i.test(html),
        }).toEqual({ script: false, handler: false, scheme: false });
      } finally {
        await hostile.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("SEC: public pages name no feed that may not be named in customer outputs", async () => {
    // Feeds shipped by decision must never be named (constitution II); feeds that do not ship are not
    // part of the customer view at all.
    const generic = new Set(["team", "tracker", "drop", "dropv6", "list", "lists"]);
    const forbidden: string[] = [];
    for (const feed of FEEDS) {
      const licence = await readLicence(feed.id);
      if (licence.status === "shippable" && !licence.shippedByDecision) continue;
      const page = await Bun.file(join(DEFAULT_WIKI_ENTITIES, `${feed.id}.md`)).text();
      const title = /^title:\s*(.+)$/m.exec(page)?.[1] ?? "";
      forbidden.push(feed.id, ...title.split(/[\s/()]+/).filter((w) => w.length >= 4 && !generic.has(w.toLowerCase())));
    }
    expect(forbidden.length).toBeGreaterThan(0);
    for (const path of PUBLIC) {
      const text = (await get(path)).html.replace(/<[^>]+>/g, " ").toLowerCase();
      const named = forbidden.filter((name) => text.includes(name.toLowerCase()));
      expect({ path, named }).toEqual({ path, named: [] });
    }
  });
});
