/**
 * Proof-of-work of the challenge page (spec 006, research R3): find a counter such that
 * SHA-256(nonce ‖ counter as 8 bytes big-endian) starts with at least `bits` zero bits.
 *
 * The input is always 24 bytes, so every attempt is a single SHA-256 block. This file uses no
 * Bun or DOM API: the browser worker and the tests share it. The server checks answers with
 * Bun.CryptoHasher, not with this file.
 */

export const NONCE_BYTES = 16;

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19] as const;

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** Compresses one block in `w` (first 16 words filled; the array has room for 64) into `out`. */
function compress(w: Uint32Array, out: Uint32Array): void {
  for (let i = 16; i < 64; i++) {
    const a = w[i - 15]!;
    const b = w[i - 2]!;
    const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
    const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
    w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
  }
  let a: number = H0[0], b: number = H0[1], c: number = H0[2], d: number = H0[3];
  let e: number = H0[4], f: number = H0[5], g: number = H0[6], h: number = H0[7];
  for (let i = 0; i < 64; i++) {
    const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  out[0] = (H0[0] + a) | 0;
  out[1] = (H0[1] + b) | 0;
  out[2] = (H0[2] + c) | 0;
  out[3] = (H0[3] + d) | 0;
  out[4] = (H0[4] + e) | 0;
  out[5] = (H0[5] + f) | 0;
  out[6] = (H0[6] + g) | 0;
  out[7] = (H0[7] + h) | 0;
}

/** The message schedule for nonce ‖ counter: 24 bytes, padded to one block (length 192 bits). */
function schedule(nonce: Uint8Array): Uint32Array {
  if (nonce.length !== NONCE_BYTES) throw new Error(`nonce must be ${NONCE_BYTES} bytes`);
  const w = new Uint32Array(64);
  for (let i = 0; i < 4; i++) {
    w[i] = (nonce[i * 4]! << 24) | (nonce[i * 4 + 1]! << 16) | (nonce[i * 4 + 2]! << 8) | nonce[i * 4 + 3]!;
  }
  w[6] = 0x80000000;
  w[15] = 192;
  return w;
}

/** SHA-256 of nonce ‖ counter (8 bytes, big-endian). */
export function sha256Block(nonce: Uint8Array, counter: bigint): Uint8Array {
  const w = schedule(nonce);
  w[4] = Number((counter >> 32n) & 0xffffffffn);
  w[5] = Number(counter & 0xffffffffn);
  const state = new Uint32Array(8);
  compress(w, state);
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = state[i]! >>> 24;
    out[i * 4 + 1] = (state[i]! >>> 16) & 0xff;
    out[i * 4 + 2] = (state[i]! >>> 8) & 0xff;
    out[i * 4 + 3] = state[i]! & 0xff;
  }
  return out;
}

export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/**
 * The smallest counter from 0 whose hash has at least `bits` leading zero bits. `onProgress`
 * receives the number of attempts every `progressEvery` attempts.
 */
export function solve(nonce: Uint8Array, bits: number, onProgress?: (tried: number) => void, progressEvery = 65536): bigint {
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error("bits must be 0–32");
  const w = schedule(nonce);
  const state = new Uint32Array(8);
  // Counters stay below 2^53, far beyond any reachable difficulty, so a number is enough.
  // compress() rewrites only w[16..63], so only the two counter words change per attempt.
  for (let counter = 0; ; counter++) {
    w[4] = Math.floor(counter / 0x100000000);
    w[5] = counter >>> 0;
    compress(w, state);
    if (bits === 0 || Math.clz32(state[0]!) >= bits) return BigInt(counter);
    if (onProgress && (counter + 1) % progressEvery === 0) onProgress(counter + 1);
  }
}
