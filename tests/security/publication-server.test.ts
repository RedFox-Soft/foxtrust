import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPublicationServer } from "../../src/publication/server";

const SECRET = "SECRET-SIGNING-KEY-MATERIAL";

/**
 * Sends one raw HTTP/1.1 request, so the request target reaches the server exactly as written
 * (fetch and URL would normalise `..` and `%2e%2e` away before sending).
 */
async function raw(port: number, method: string, target: string): Promise<{ status: number; body: string }> {
  const chunks: Uint8Array[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data: (_s, data) => void chunks.push(new Uint8Array(data)),
      close: () => resolve(),
      error: (_s, error) => reject(error),
    },
  });
  socket.write(`${method} ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  await promise;
  const text = Buffer.concat(chunks).toString("latin1");
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
  return { status, body: text.slice(text.indexOf("\r\n\r\n") + 4) };
}

describe("SEC: publication server", () => {
  let root: string;
  let server: ReturnType<typeof startPublicationServer>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "foxtrust-pubsec-"));
    const dir = join(root, "publication");
    await mkdir(join(dir, "v1", "full"), { recursive: true });
    await Bun.write(join(dir, "v1", "manifest.json"), "{}\n");
    await Bun.write(join(dir, "v1", "full", "f20261001.mmdb"), "mmdb");
    // Secrets next to the publication root and inside it, outside v1/.
    await Bun.write(join(root, "signing.key.pem"), SECRET);
    await Bun.write(join(dir, "signing.key.pem"), SECRET);
    server = startPublicationServer({ dir, port: 0 });
  });

  afterAll(async () => {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  });

  test("SEC: publication server rejects path traversal", async () => {
    // Sanity: the served file is reachable.
    expect((await raw(server.port, "GET", "/v1/manifest.json")).status).toBe(200);
    const targets = [
      "/v1/../signing.key.pem",
      "/v1/../../signing.key.pem",
      "/v1/full/../../../signing.key.pem",
      "/v1/%2e%2e/signing.key.pem",
      "/v1/%2e%2e/%2e%2e/signing.key.pem",
      "/v1/%2E%2E%2Fsigning.key.pem",
      "/v1/..%2f..%2fsigning.key.pem",
      "/v1/..%5c..%5csigning.key.pem",
      "/v1\\..\\..\\signing.key.pem",
      "/v1/%00/../signing.key.pem",
      `/${join(root, "signing.key.pem").replaceAll("\\", "/")}`,
      "//etc/passwd",
      "/signing.key.pem",
      "/C:/Windows/win.ini",
    ];
    for (const target of targets) {
      const res = await raw(server.port, "GET", target);
      expect({ target, status: res.status }).toEqual({ target, status: 404 });
      expect(res.body).not.toContain(SECRET);
    }
  });

  test("SEC: publication server rejects non-GET methods", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await raw(server.port, method, "/v1/manifest.json");
      expect({ method, status: res.status }).toEqual({ method, status: 405 });
    }
    expect(await Bun.file(join(root, "publication", "v1", "manifest.json")).text()).toBe("{}\n");
  });

  test("SEC: publication server does not list directories", async () => {
    for (const target of ["/v1/", "/v1", "/v1/full/", "/v1/full", "/"]) {
      const res = await raw(server.port, "GET", target);
      expect({ target, status: res.status }).toEqual({ target, status: 404 });
      expect(res.body).not.toContain("f20261001");
    }
  });
});
