import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { keyId } from "../../src/snapshot/sign";
import { startFakeOidc } from "../helpers/oidc";
import { startTestSite, type TestSite } from "../helpers/site";

const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const KEYS = [key(), key()];
const ENV = {
  FOXTRUST_SITE_API_URL: "https://api.example.test",
  FOXTRUST_SITE_PUBLICATION_URL: "https://data.example.test",
  FOXTRUST_TRUSTED_KEYS: KEYS.join(","),
  FOXTRUST_API_FREE_DAILY: "1234",
  FOXTRUST_API_FREE_BURST: "7",
};

describe("US1 (spec 012): a visitor learns what FoxTrust is and how to dispute a listing", () => {
  let site: TestSite;

  beforeAll(async () => {
    site = await startTestSite({ env: ENV });
  });

  afterAll(async () => {
    await site?.stop();
  });

  const page = async (path: string, at = site) => {
    const res = await fetch(`${at.url}${path}`, { redirect: "manual" });
    return { status: res.status, headers: res.headers, html: await res.text() };
  };

  test("US1-1: /dispute shows docs/dispute.md with its headings, table, code and a mail link", async () => {
    const markdown = await Bun.file(`${import.meta.dir}/../../docs/dispute.md`).text();
    const { status, html } = await page("/dispute");
    expect(status).toBe(200);
    for (const heading of markdown.match(/^#{1,3} .+$/gm)!) {
      expect(html).toContain(heading.replace(/^#+ /, "").replace(/\?$/, ""));
    }
    expect(html).toContain("<table>");
    expect(html).toContain("<pre>");
    expect(html).toContain('<a href="mailto:disputes@foxtrust.dev">');
  });

  test("US1-2: the landing page explains the two signal layers and links the dispute page, the docs and sign-in", async () => {
    const { status, html } = await page("/");
    expect(status).toBe(200);
    expect(html).toContain("Network categories");
    expect(html).toContain("Observed behaviour");
    for (const link of ['href="/dispute"', 'href="/docs/api"', 'href="/docs/snapshots"']) expect(html).toContain(link);
    expect(html).not.toContain('href="/auth/login"');

    const oidc = await startFakeOidc({ clientId: "foxtrust-site-test" });
    const withSignIn = await startTestSite({ env: ENV, oidc, sql: new SQL("postgres://nobody:none@127.0.0.1:1/none") });
    try {
      expect((await page("/", withSignIn)).html).toContain('href="/auth/login"');
    } finally {
      await withSignIn.stop();
      await oidc.stop();
    }
  });

  test("US1-3: the API documentation matches spec 010 with the configured host and limits", async () => {
    const { status, html } = await page("/docs/api");
    expect(status).toBe(200);
    for (const text of ["GET https://api.example.test/v1/ip/", "Authorization: Bearer", "X-API-Key", "1,234", "7 per second", "400", "401", "429", "503", "ssh_bruteforce"]) {
      expect(html).toContain(text);
    }
  });

  test("US1-4: the snapshot documentation gives the publication address and every trusted key with its key id", async () => {
    const { status, html } = await page("/docs/snapshots");
    expect(status).toBe(200);
    expect(html).toContain("https://data.example.test/v1/");
    for (const k of KEYS) {
      expect(html).toContain(k);
      expect(html).toContain(keyId(k));
    }
  });

  test("US1-5: public pages load while the database and foxauth are both down", async () => {
    const oidc = await startFakeOidc({ clientId: "foxtrust-site-test" });
    oidc.goOffline();
    const down = await startTestSite({ env: ENV, oidc, sql: new SQL("postgres://nobody:none@127.0.0.1:1/none") });
    try {
      for (const path of ["/", "/dispute", "/docs/api", "/docs/snapshots"]) expect({ path, status: (await page(path, down)).status }).toEqual({ path, status: 200 });
    } finally {
      await down.stop();
      await oidc.stop();
    }
  });

  test("US1-6: an unknown or reserved path gets the not-found page with links home and to the dispute page", async () => {
    for (const path of ["/nope", "/ip/1.1.1.1", "/asn/13335"]) {
      const { status, html } = await page(path);
      expect({ path, status }).toEqual({ path, status: 404 });
      expect(html).toContain('href="/"');
      expect(html).toContain('href="/dispute"');
    }
  });
});
