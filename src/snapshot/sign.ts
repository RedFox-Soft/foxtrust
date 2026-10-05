/**
 * Ed25519 signing for published files (research R4): detached 64-byte raw signatures,
 * 32-byte raw public keys (base64), key id = first 8 hex digits of sha256(public key).
 * Built on WebCrypto; no dependencies.
 */

export type PublicKeyInfo = { keyId: string; publicKey: string; validFrom: string; validTo: string | null };

export type SigningKey = { keyId: string; publicKey: string; privateKey: CryptoKey };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unb64 = (text: string) => new Uint8Array(Buffer.from(text.trim(), "base64"));

export function keyId(publicKeyB64: string): string {
  return new Bun.CryptoHasher("sha256").update(unb64(publicKeyB64)).digest("hex").slice(0, 8);
}

function pem(label: string, der: Uint8Array): string {
  const body = b64(der).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function unpem(text: string, label: string): Uint8Array {
  const match = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`).exec(text);
  if (!match) throw new Error(`not a PEM ${label}`);
  return unb64(match[1]!.replace(/\s+/g, ""));
}

/** New key pair: PKCS#8 PEM private key, base64 raw public key and its key id. */
export async function generateKeyPair(): Promise<{ privateKeyPem: string; publicKey: string; publicKeyPem: string; keyId: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const publicKey = b64(raw);
  return { privateKeyPem: pem("PRIVATE KEY", pkcs8), publicKey, publicKeyPem: pem("PUBLIC KEY", spki), keyId: keyId(publicKey) };
}

/** Loads a PKCS#8 PEM Ed25519 private key and derives its public key. */
export async function loadSigningKey(pemPath: string): Promise<SigningKey> {
  const file = Bun.file(pemPath);
  if (!(await file.exists())) throw new Error(`signing key ${pemPath} not found`);
  const pkcs8 = unpem(await file.text(), "PRIVATE KEY");
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8 as Uint8Array<ArrayBuffer>, { name: "Ed25519" }, true, ["sign"]);
  // The public key is the JWK "x" member of the private key.
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (!jwk.x) throw new Error("cannot derive the public key");
  const publicKey = b64(new Uint8Array(Buffer.from(jwk.x, "base64url")));
  return { keyId: keyId(publicKey), publicKey, privateKey };
}

export async function sign(bytes: Uint8Array, key: SigningKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("Ed25519", key.privateKey, bytes as Uint8Array<ArrayBuffer>));
}

export type TrustedKey = { keyId: string; key: CryptoKey };

/** Imports base64 raw Ed25519 public keys (e.g. from FOXTRUST_TRUSTED_KEYS). */
export async function importTrustedKeys(publicKeys: string[]): Promise<TrustedKey[]> {
  const out: TrustedKey[] = [];
  for (const k of publicKeys.map((s) => s.trim()).filter(Boolean)) {
    const raw = unb64(k);
    if (raw.length !== 32) throw new Error(`trusted key ${k.slice(0, 12)}… is not a 32-byte Ed25519 key`);
    out.push({ keyId: keyId(k), key: await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]) });
  }
  return out;
}

/** True with the key id when any trusted key verifies the signature. */
export async function verify(bytes: Uint8Array, signature: Uint8Array, trusted: TrustedKey[]): Promise<{ ok: boolean; keyId: string | null }> {
  if (signature.length !== 64) return { ok: false, keyId: null };
  for (const t of trusted) {
    if (await crypto.subtle.verify("Ed25519", t.key, signature as Uint8Array<ArrayBuffer>, bytes as Uint8Array<ArrayBuffer>)) {
      return { ok: true, keyId: t.keyId };
    }
  }
  return { ok: false, keyId: null };
}

export async function readKeysFile(path: string): Promise<PublicKeyInfo[]> {
  const file = Bun.file(path);
  return (await file.exists()) ? ((await file.json()) as PublicKeyInfo[]) : [];
}

export async function writeKeysFile(path: string, keys: PublicKeyInfo[]): Promise<void> {
  await Bun.write(path, `${JSON.stringify(keys, null, 2)}\n`);
}

export { b64 as toBase64, unb64 as fromBase64 };
