import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPublicationServer } from "../../src/publication/server";
import { generateKeyPair } from "../../src/snapshot/sign";

export type TestPublication = {
  dir: string;
  url: string;
  publicKey: string;
  keyId: string;
  signingKeyPath: string;
  /** Requests served so far (to prove `/verify` answers without the network). */
  requests: () => number;
  /** Stops serving (an outage) but keeps the files. */
  goOffline: () => Promise<void>;
  stop: () => Promise<void>;
};

/** A temporary publication directory with a fresh key pair, served on a random port. */
export async function createTestPublication(): Promise<TestPublication> {
  const root = await mkdtemp(join(tmpdir(), "foxtrust-pub-"));
  const dir = join(root, "publication");
  const pair = await generateKeyPair();
  const signingKeyPath = join(root, "signing.key.pem");
  await Bun.write(signingKeyPath, pair.privateKeyPem);
  const server = startPublicationServer({ dir, port: 0, hostname: "127.0.0.1" });
  let online = true;
  const goOffline = async () => {
    if (online) await server.stop();
    online = false;
  };
  return {
    dir,
    url: `http://127.0.0.1:${server.port}`,
    publicKey: pair.publicKey,
    keyId: pair.keyId,
    signingKeyPath,
    requests: () => server.requests(),
    goOffline,
    stop: async () => {
      await goOffline();
      await rm(root, { recursive: true, force: true });
    },
  };
}
