import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFeed } from "../../src/ingest/run";
import { parseCidr, type Cidr } from "../../src/ip/cidr";
import { loadConfig } from "../../src/scoring/config";
import { vocabularyFromConfig } from "../../src/policy";
import { buildAndRelease, type ReleaseOptions } from "../../src/snapshot/publish";
import { generateKeyPair, importTrustedKeys, loadSigningKey, sign } from "../../src/snapshot/sign";
import { createLoader, type Loader } from "../../src/verify/loader";
import { createPolicyHolder } from "../../src/verify/policy-file";
import { startVerifyServer } from "../../src/verify/server";
import { describeDb, withTestDb } from "../helpers/db";
import { fixturePath, loadFixtureDataset, STAGE2_CONFIG } from "../helpers/fixture-data";
import { createTestPublication, type TestPublication } from "../helpers/publication";

const POLICY = join(import.meta.dir, "..", "fixtures", "policies", "example.yaml");
const LOOPBACK: Cidr[] = [parseCidr("127.0.0.1/32")!, parseCidr("::1/128")!];
const HOUR = 3_600_000;
const HOSTING_V6 = "2001:418:1401:4::1"; // X4BNet hosting prefix in the fixture
const TOR_MOVED_TO = "1.12.0.5"; // inside an X4BNet hosting prefix

type Service = { port: number; loader: Loader; stop: () => Promise<void> };

/** Asks /verify about a request from `client` (sent through the loopback "proxy"). */
async function ask(port: number, client: string, path = "/login") {
  const res = await fetch(`http://127.0.0.1:${port}/verify?proxy=traefik`, {
    headers: { "X-Forwarded-For": client, "X-Forwarded-Uri": path },
    redirect: "manual",
  });
  await res.arrayBuffer();
  return {
    status: res.status,
    snapshot: res.headers.get("x-foxtrust-snapshot"),
    rule: res.headers.get("x-foxtrust-rule"),
    risk: res.headers.get("x-foxtrust-risk"),
    noData: res.headers.get("x-foxtrust-no-data"),
  };
}

describeDb("US2: /verify keeps its snapshot current", () => {
  const db = withTestDb();
  let tmp: string;
  let pub: TestPublication;
  let opts: ReleaseOptions;
  let tor: string;
  let fullVersion: string;
  let deltaVersion: string;
  let lastBuild: Date;
  let offsetMs = 0;
  let service: Service;
  let t0: Date;

  async function startService(trusted: string[], clock = () => new Date(Date.now() + offsetMs)): Promise<Service> {
    const loader = createLoader({ publicationUrl: pub.url, trustedKeys: await importTrustedKeys(trusted), maxAgeHours: 26, clock });
    const policy = createPolicyHolder(POLICY, vocabularyFromConfig(await loadConfig(STAGE2_CONFIG)));
    await policy.load();
    const server = startVerifyServer({
      loader, policy, port: 0, hostname: "127.0.0.1", log: () => {},
      config: { trustedProxies: LOOPBACK, failMode: "open", challengeUrl: null, challengeFallback: "allow", challengeSecret: null },
    });
    return { port: server.port, loader, stop: server.stop };
  }

  /** Publishes as if `hours` after t0 (versions are per UTC hour and day). */
  async function publishAt(kind: "full" | "delta", hours: number, extra: Partial<ReleaseOptions> = {}) {
    const at = new Date(t0.getTime() + hours * HOUR);
    const r = await buildAndRelease(db.sql, kind, { ...opts, ...extra, at, now: at });
    if (r.status !== "published") throw new Error(`${kind} release: ${JSON.stringify(r)}`);
    lastBuild = at;
    return r;
  }

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "foxtrust-us2-"));
    await loadFixtureDataset(db.sql);
    t0 = new Date();
    tor = (await Bun.file(fixturePath("tor-exit", "exit-list.txt")).text()).split("\n").find((l) => l.startsWith("ExitAddress"))!.split(/\s+/)[1]!;
    pub = await createTestPublication();
    opts = {
      dir: pub.dir, workDir: join(tmp, "work"), key: await loadSigningKey(pub.signingKeyPath),
      disputeUrl: "https://foxtrust.example/dispute", sample: 200,
    };
    fullVersion = (await publishAt("full", 0)).version;
    service = await startService([pub.publicKey]);
    await service.loader.check();
  }, 180_000);

  afterAll(async () => {
    await service?.stop();
    await pub?.stop();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  test("US2-1: after loading, /verify answers without any network or database call (IPv4/IPv6)", async () => {
    // The real `verify serve`, with a database URL that points nowhere.
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "..", "src", "cli", "main.ts"), "verify", "serve"], {
      env: {
        ...Bun.env,
        DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
        FOXTRUST_PUBLICATION_URL: pub.url,
        FOXTRUST_TRUSTED_KEYS: pub.publicKey,
        FOXTRUST_POLICY_FILE: POLICY,
        FOXTRUST_TRUSTED_PROXIES: "127.0.0.1/32,::1/128",
        FOXTRUST_UPDATE_EVERY: "0 0 1 1 *",
        PORT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = proc.stdout.getReader();
      let out = "";
      while (!/port (\d+)/.test(out)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`verify serve exited: ${await new Response(proc.stderr).text()}`);
        out += new TextDecoder().decode(value);
      }
      const port = Number(/port (\d+)/.exec(out)![1]);
      for (let i = 0; i < 100; i++) {
        const status = (await (await fetch(`http://127.0.0.1:${port}/status`)).json()) as { snapshotVersion: string | null };
        if (status.snapshotVersion) break;
        await Bun.sleep(50);
      }
      const before = pub.requests();
      const torAnswer = await ask(port, tor);
      expect(torAnswer).toMatchObject({ status: 200, snapshot: fullVersion, rule: "tor-on-login" });
      const v6 = await ask(port, HOSTING_V6, "/");
      expect(v6).toMatchObject({ status: 200, snapshot: fullVersion, rule: "default", risk: "12" });
      for (let i = 0; i < 50; i++) await ask(port, i % 2 ? tor : HOSTING_V6);
      expect(pub.requests()).toBe(before);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 60_000);

  test("US2-2: a new delta is picked up; 2,000 concurrent answers during the swap use one version or the other (IPv4/IPv6)", async () => {
    const changed = join(tmp, "exit-list.txt");
    const exitList = await Bun.file(fixturePath("tor-exit", "exit-list.txt")).text();
    await Bun.write(changed, exitList.replaceAll(`ExitAddress ${tor} `, `ExitAddress ${TOR_MOVED_TO} `));
    expect((await runFeed(db.sql, "tor-exit", { fromFiles: [changed], artifactRoot: join(tmp, "artifacts") })).status).toBe("applied");
    deltaVersion = (await publishAt("delta", 1)).version;

    const both = `${fullVersion}+${deltaVersion}`;
    const answers = await Promise.all([
      service.loader.check(),
      ...Array.from({ length: 2000 }, (_, i) => ask(service.port, i % 2 ? tor : HOSTING_V6)),
    ]);
    const results = answers.slice(1) as Awaited<ReturnType<typeof ask>>[];
    for (const r of results) {
      expect(r.status).toBe(200);
      expect([fullVersion, both]).toContain(r.snapshot!);
    }
    // Never a mix: the moved Tor exit is tor-on-login in the old data and default in the new.
    const torAnswers = results.filter((_, i) => i % 2 === 1);
    for (const r of torAnswers) expect(r.rule).toBe(r.snapshot === fullVersion ? "tor-on-login" : "default");
    expect(await ask(service.port, tor)).toMatchObject({ snapshot: both, rule: "default" });
    expect(await ask(service.port, TOR_MOVED_TO)).toMatchObject({ snapshot: both, rule: "tor-on-login" });
    expect(service.loader.status()).toMatchObject({ snapshotVersion: fullVersion, deltaVersion, lastError: null });
  }, 120_000);

  test("US2-3: a tampered delta is rejected; answers do not change (IPv4)", async () => {
    const next = await publishAt("delta", 2);
    const path = join(pub.dir, next.path!);
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    bytes[100] = bytes[100]! ^ 0xff;
    await Bun.write(path, bytes);

    const before = await ask(service.port, TOR_MOVED_TO);
    await service.loader.check();
    const status = service.loader.status();
    expect(status.deltaVersion).toBe(deltaVersion);
    expect(status.lastError).toContain(next.path);
    expect(await ask(service.port, TOR_MOVED_TO)).toEqual(before);
  }, 60_000);

  test("US2-5: a delta whose base differs from the full snapshot is not applied; the next full snapshot is loaded", async () => {
    const newFull = await publishAt("full", 26);
    // A manifest (validly signed) that pairs the new full snapshot with the old delta.
    const manifestPath = join(pub.dir, "v1", "manifest.json");
    const manifest = await Bun.file(manifestPath).json();
    const archive = await Bun.file(join(pub.dir, "v1", "archive", "index.json")).json();
    const oldDelta = archive.find((e: { version: string }) => e.version === deltaVersion);
    manifest.delta = { ...manifest.full, version: deltaVersion, path: oldDelta.path, sha256: oldDelta.sha256, base: fullVersion };
    const bytes = new TextEncoder().encode(JSON.stringify(manifest));
    await Bun.write(manifestPath, bytes);
    await Bun.write(`${manifestPath}.sig`, await sign(bytes, opts.key));

    await service.loader.check();
    const status = service.loader.status();
    expect(status.snapshotVersion).toBe(newFull.version);
    expect(status.deltaVersion).toBeNull();
    expect(status.lastError).toContain(`based on ${fullVersion}`);
    expect((await ask(service.port, TOR_MOVED_TO)).snapshot).toBe(newFull.version);
  }, 60_000);

  test("US2-6: key rotation: a new key is accepted while both are trusted; the old key alone is rejected after its removal", async () => {
    const pair = await generateKeyPair();
    const newKeyPath = join(tmp, "new.key.pem");
    await Bun.write(newKeyPath, pair.privateKeyPem);
    const newKey = await loadSigningKey(newKeyPath);

    const both = await startService([pub.publicKey, pair.publicKey]);
    try {
      const signedByNew = await publishAt("full", 50, { key: newKey });
      await both.loader.check();
      expect(both.loader.status()).toMatchObject({ snapshotVersion: signedByNew.version, lastError: null });
    } finally {
      await both.stop();
    }

    // Restarted with only the new key; the publication is signed with the old key only.
    const signedByOld = await publishAt("full", 74);
    const onlyNew = await startService([pair.publicKey]);
    try {
      await onlyNew.loader.check();
      expect(onlyNew.loader.status()).toMatchObject({ snapshotVersion: null, lastError: "manifest signature" });
      expect((await ask(onlyNew.port, tor)).noData).toBe("1");
      expect(signedByOld.version).not.toBe(fullVersion);
    } finally {
      await onlyNew.stop();
    }
  }, 60_000);

  // Last: it stops the publication.
  test("US2-4: past the maximum age with the publication down, answers come from the last data and the status is stale (IPv4/IPv6)", async () => {
    await service.loader.check(); // back on the latest full snapshot
    const loaded = service.loader.status().snapshotVersion;
    const before = [await ask(service.port, TOR_MOVED_TO), await ask(service.port, HOSTING_V6, "/")];
    await pub.goOffline();
    offsetMs = lastBuild.getTime() - Date.now() + 30 * HOUR;

    await service.loader.check();
    const status = service.loader.status();
    expect(status.snapshotVersion).toBe(loaded);
    expect(status.stale).toBe(true);
    expect(status.ageSeconds!).toBeGreaterThan(26 * 3600);
    expect(status.lastError).not.toBeNull();
    expect([await ask(service.port, TOR_MOVED_TO), await ask(service.port, HOSTING_V6, "/")]).toEqual(before);
  }, 60_000);
});
