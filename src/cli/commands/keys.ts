import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { publicationDir } from "../../snapshot/publish";
import { generateKeyPair, keyId, readKeysFile, writeKeysFile } from "../../snapshot/sign";
import { EXIT, parseDate, printJson, printLine, rejectUnknown, takeOption, UsageError, warn, type Context } from "../util";

export { publicationDir };

/** `keys generate --out <dir>`: writes signing.key.pem (private) and <keyId>.pub (base64 raw). */
export async function keysGenerate(args: string[], ctx: Context): Promise<number> {
  const [out] = takeOption(args, "--out");
  rejectUnknown(args);
  if (!out) throw new UsageError("--out <dir> is required");
  const privatePath = join(out, "signing.key.pem");
  if (await Bun.file(privatePath).exists()) throw new UsageError(`${privatePath} already exists; refusing to overwrite a signing key`);
  await mkdir(out, { recursive: true });
  const pair = await generateKeyPair();
  await Bun.write(privatePath, pair.privateKeyPem);
  await Bun.write(join(out, `${pair.keyId}.pub`), `${pair.publicKey}\n`);
  await Bun.write(join(out, `${pair.keyId}.pub.pem`), pair.publicKeyPem);
  if (ctx.json) printJson({ keyId: pair.keyId, publicKey: pair.publicKey, privateKey: privatePath });
  else {
    printLine(`Key id:      ${pair.keyId}`);
    printLine(`Public key:  ${pair.publicKey}`);
    printLine(`Private key: ${privatePath}  (keep it secret; never commit it)`);
  }
  warn("Store the private key as a secret (FOXTRUST_SIGNING_KEY); pin the public key in FOXTRUST_TRUSTED_KEYS.");
  return EXIT.ok;
}

/** `keys add <file.pub> [--valid-from] [--valid-to]`: adds a public key to <publication>/v1/keys.json. */
export async function keysAdd(args: string[], ctx: Context): Promise<number> {
  const [from] = takeOption(args, "--valid-from");
  const [to] = takeOption(args, "--valid-to");
  rejectUnknown(args);
  const file = args[0];
  if (!file || args.length > 1) throw new UsageError("expected exactly one public key file");
  const publicKey = (await Bun.file(file).text()).trim();
  const id = keyId(publicKey);
  const path = join(publicationDir(), "v1", "keys.json");
  await mkdir(join(publicationDir(), "v1"), { recursive: true });
  const keys = (await readKeysFile(path)).filter((k) => k.keyId !== id);
  keys.push({
    keyId: id,
    publicKey,
    validFrom: (from ? parseDate(from, "--valid-from") : new Date()).toISOString(),
    validTo: to ? parseDate(to, "--valid-to").toISOString() : null,
  });
  await writeKeysFile(path, keys);
  if (ctx.json) printJson({ keys });
  else printLine(`${path}: ${keys.length} key(s), added ${id}`);
  return EXIT.ok;
}
