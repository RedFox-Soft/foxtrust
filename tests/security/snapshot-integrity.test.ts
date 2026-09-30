import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseCidr } from "../../src/ip/cidr";
import { toIpValue, type IpValue } from "../../src/ip/parse";
import { MmdbWriter } from "../../src/mmdb/writer";
import { SNAPSHOT_DB_TYPE } from "../../src/snapshot/build";
import { generateKeyPair, importTrustedKeys, loadSigningKey, sign, type SigningKey } from "../../src/snapshot/sign";
import { createLoader, type Loader } from "../../src/verify/loader";
import { createTestPublication, type TestPublication } from "../helpers/publication";

const IP = toIpValue("198.51.100.7") as IpValue;
const IP6 = toIpValue("2001:db8::7") as IpValue;

function snapshot(risk: number, padBytes = 0): Uint8Array {
  const writer = new MmdbWriter({
    databaseType: SNAPSHOT_DB_TYPE,
    description: { en: "test" + " ".repeat(padBytes) },
    languages: ["en"],
    doubleKeys: ["risk", "contribution"],
    buildEpoch: 1_790_000_000,
  });
  const record = { risk, level: risk >= 70 ? "high" : "low", categories: ["hosting"], reasons: [{ code: "hosting", last_seen: 1_790_000_000, contribution: risk }], network: {} };
  writer.insert(parseCidr("198.51.100.0/24")!, record);
  writer.insert(parseCidr("2001:db8::/32")!, record);
  return writer.build();
}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

describe("SEC: snapshot integrity in the /verify loader", () => {
  let pub: TestPublication;
  let key: SigningKey;
  let loader: Loader;
  let day = 1;

  /**
   * Publishes a full snapshot and a manifest. `alter` changes the served file or manifest after
   * signing, the way an attacker or a broken transfer would.
   */
  async function publish(opts: {
    risk: number;
    fileKey?: SigningKey;
    manifestKey?: SigningKey;
    padBytes?: number;
    alterFile?: (bytes: Uint8Array) => Uint8Array;
    alterEntry?: (entry: Record<string, unknown>) => void;
  }): Promise<string> {
    const version = `f202610${String(day++).padStart(2, "0")}`;
    const bytes = snapshot(opts.risk, opts.padBytes);
    const path = `v1/full/${version}.mmdb`;
    await mkdir(join(pub.dir, "v1", "full"), { recursive: true });
    await Bun.write(join(pub.dir, path), opts.alterFile ? opts.alterFile(bytes) : bytes);
    await Bun.write(join(pub.dir, `${path}.sig`), await sign(bytes, opts.fileKey ?? key));
    const entry: Record<string, unknown> = {
      version, path, sha256: sha256(bytes), size: bytes.length, builtAt: new Date().toISOString(),
      dataVersion: "dv1", algorithm: "noisy-or/1", configSha256: "0".repeat(64), keyId: key.keyId,
    };
    opts.alterEntry?.(entry);
    const manifest = new TextEncoder().encode(
      JSON.stringify({ format: 1, generatedAt: new Date().toISOString(), full: entry, delta: null, keys: [], notices: [], disputeUrl: "https://foxtrust.example/dispute" }),
    );
    await Bun.write(join(pub.dir, "v1", "manifest.json"), manifest);
    await Bun.write(join(pub.dir, "v1", "manifest.json.sig"), await sign(manifest, opts.manifestKey ?? key));
    return version;
  }

  let good: string;
  const answers = () => [loader.source().lookup(IP)?.risk ?? null, loader.source().lookup(IP6)?.risk ?? null, loader.source().snapshotVersion];

  beforeAll(async () => {
    pub = await createTestPublication();
    key = await loadSigningKey(pub.signingKeyPath);
    loader = createLoader({ publicationUrl: pub.url, trustedKeys: await importTrustedKeys([pub.publicKey]), maxAgeHours: 26, maxBytes: 1024 * 1024 });
    good = await publish({ risk: 12 });
    await loader.check();
    expect(answers()).toEqual([12, 12, good]);
  });

  afterAll(async () => {
    await pub?.stop();
  });

  test("SEC: tampered snapshot is rejected", async () => {
    const version = await publish({
      risk: 99,
      alterFile: (b) => {
        const out = b.slice();
        out[10] = out[10]! ^ 0xff;
        return out;
      },
    });
    await loader.check();
    expect(answers()).toEqual([12, 12, good]);
    expect(loader.status().lastError).toContain(`${version}.mmdb: signature does not verify`);
  });

  test("SEC: truncated snapshot is rejected", async () => {
    const version = await publish({ risk: 99, alterFile: (b) => b.slice(0, Math.floor(b.length / 2)) });
    await loader.check();
    expect(answers()).toEqual([12, 12, good]);
    expect(loader.status().lastError).toContain(`${version}.mmdb`);
  });

  test("SEC: manifest signed by an untrusted key is ignored", async () => {
    const pair = await generateKeyPair();
    const path = join(pub.dir, "..", "untrusted.key.pem");
    await Bun.write(path, pair.privateKeyPem);
    const untrusted = await loadSigningKey(path);
    await publish({ risk: 99, fileKey: untrusted, manifestKey: untrusted });
    await loader.check();
    expect(answers()).toEqual([12, 12, good]);
    expect(loader.status().lastError).toBe("manifest signature");
  });

  test("SEC: manifest pointing to a file whose sha256 differs is ignored", async () => {
    const version = await publish({ risk: 99, alterEntry: (e) => void (e.sha256 = "f".repeat(64)) });
    await loader.check();
    expect(answers()).toEqual([12, 12, good]);
    expect(loader.status().lastError).toBe(`v1/full/${version}.mmdb: sha256 differs from the manifest`);
  });

  test("SEC: oversized snapshot download is aborted", async () => {
    // The manifest understates the size: reading stops at the stated size.
    const understated = await publish({ risk: 99, padBytes: 64 * 1024, alterEntry: (e) => void (e.size = 4096) });
    await loader.check();
    expect(answers()).toEqual([12, 12, good]);
    expect(loader.status().lastError).toContain(`${understated}.mmdb: response from`);
    expect(loader.status().lastError).toContain("exceeds 4096 bytes");

    // A file over the loader's limit is not downloaded at all.
    const huge = await publish({ risk: 99, alterEntry: (e) => void (e.size = 2 * 1024 * 1024) });
    const before = pub.requests();
    await loader.check();
    expect(answers()).toEqual([12, 12, good]);
    expect(loader.status().lastError).toContain(`${huge}.mmdb: 2097152 bytes is over the 1048576 limit`);
    expect(pub.requests() - before).toBe(2); // manifest and its signature only
  });
});
