import type { IpValue } from "../ip/parse";
import type { MmdbValue } from "./writer";

/**
 * MaxMind DB format 2.0 reader for the in-memory lookup of `/verify` (research R1).
 * Supports record sizes 24/28/32, IPv4 and IPv6 databases, pointers and every data type.
 * No dependencies, no database imports.
 */

const MARKER = [0xab, 0xcd, 0xef, ...new TextEncoder().encode("MaxMind.com")];
const DATA_SEPARATOR = 16;
const textDecoder = new TextDecoder();

export type MmdbMetadata = {
  node_count: number;
  record_size: number;
  ip_version: number;
  database_type: string;
  languages: string[];
  binary_format_major_version: number;
  binary_format_minor_version: number;
  build_epoch: number;
  description: Record<string, string>;
};

export type Mmdb = {
  metadata: MmdbMetadata;
  /** The record for `ip`, or null when the database has no data for it. */
  get(ip: IpValue): MmdbValue | null;
};

export class MmdbFormatError extends Error {}

function findMetadataStart(bytes: Uint8Array): number {
  const floor = Math.max(0, bytes.length - 128 * 1024);
  outer: for (let i = bytes.length - MARKER.length; i >= floor; i--) {
    for (let j = 0; j < MARKER.length; j++) if (bytes[i + j] !== MARKER[j]) continue outer;
    return i + MARKER.length;
  }
  throw new MmdbFormatError("MaxMind DB metadata marker not found");
}

class Decoder {
  private view: DataView;
  constructor(
    private readonly bytes: Uint8Array,
    private readonly base: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Decodes the value at `offset` (relative to `base`). Returns [value, nextOffset]. */
  decode(offset: number, depth = 0): [MmdbValue, number] {
    if (depth > 64) throw new MmdbFormatError("data section nesting too deep");
    const at = this.base + offset;
    if (at >= this.bytes.length) throw new MmdbFormatError("data offset out of range");
    const ctrl = this.bytes[at]!;
    let type = ctrl >> 5;
    let pos = offset + 1;
    if (type === 1) {
      // Pointer: SS size bits, VVV value bits.
      const ss = (ctrl >> 3) & 0x3;
      const vvv = ctrl & 0x7;
      let pointer: number;
      if (ss === 0) {
        pointer = (vvv << 8) | this.u8(pos);
        pos += 1;
      } else if (ss === 1) {
        pointer = ((vvv << 16) | (this.u8(pos) << 8) | this.u8(pos + 1)) + 2048;
        pos += 2;
      } else if (ss === 2) {
        pointer = ((vvv << 24) | (this.u8(pos) << 16) | (this.u8(pos + 1) << 8) | this.u8(pos + 2)) + 526336;
        pos += 3;
      } else {
        pointer = this.view.getUint32(this.base + pos, false);
        pos += 4;
      }
      const [value] = this.decode(pointer, depth + 1);
      return [value, pos];
    }
    if (type === 0) {
      type = 7 + this.u8(pos);
      pos += 1;
    }
    let size = ctrl & 0x1f;
    if (size === 29) {
      size = 29 + this.u8(pos);
      pos += 1;
    } else if (size === 30) {
      size = 285 + ((this.u8(pos) << 8) | this.u8(pos + 1));
      pos += 2;
    } else if (size === 31) {
      size = 65821 + ((this.u8(pos) << 16) | (this.u8(pos + 1) << 8) | this.u8(pos + 2));
      pos += 3;
    }
    switch (type) {
      case 2:
        return [textDecoder.decode(this.slice(pos, size)), pos + size];
      case 3:
        return [this.view.getFloat64(this.base + pos, false), pos + 8];
      case 4:
        return [Array.from(this.slice(pos, size)).join(","), pos + size];
      case 5:
      case 6:
      case 9:
      case 10: {
        let v = 0n;
        for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(this.u8(pos + i));
        return [v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : Number(v), pos + size];
      }
      case 8: {
        let v = 0;
        for (let i = 0; i < size; i++) v = (v << 8) | this.u8(pos + i);
        return [size === 4 ? v | 0 : v, pos + size];
      }
      case 7: {
        const out: Record<string, MmdbValue> = {};
        let p = pos;
        for (let i = 0; i < size; i++) {
          const [key, afterKey] = this.decode(p, depth + 1);
          const [value, afterValue] = this.decode(afterKey, depth + 1);
          out[String(key)] = value;
          p = afterValue;
        }
        return [out, p];
      }
      case 11: {
        const out: MmdbValue[] = [];
        let p = pos;
        for (let i = 0; i < size; i++) {
          const [value, next] = this.decode(p, depth + 1);
          out.push(value);
          p = next;
        }
        return [out, p];
      }
      case 14:
        return [size !== 0, pos];
      case 15:
        return [this.view.getFloat32(this.base + pos, false), pos + 4];
      default:
        throw new MmdbFormatError(`unsupported data type ${type}`);
    }
  }

  private u8(offset: number): number {
    const v = this.bytes[this.base + offset];
    if (v === undefined) throw new MmdbFormatError("unexpected end of data");
    return v;
  }

  private slice(offset: number, size: number): Uint8Array {
    if (this.base + offset + size > this.bytes.length) throw new MmdbFormatError("unexpected end of data");
    return this.bytes.subarray(this.base + offset, this.base + offset + size);
  }
}

/** Parses an MMDB file held in memory. Throws MmdbFormatError for malformed input. */
export function openMmdb(bytes: Uint8Array): Mmdb {
  const metaStart = findMetadataStart(bytes);
  const [meta] = new Decoder(bytes, metaStart).decode(0);
  const metadata = meta as unknown as MmdbMetadata;
  const { node_count: nodeCount, record_size: recordSize, ip_version: ipVersion } = metadata;
  if (![24, 28, 32].includes(recordSize)) throw new MmdbFormatError(`unsupported record size ${recordSize}`);
  const nodeBytes = (recordSize * 2) / 8;
  const treeSize = nodeCount * nodeBytes;
  if (treeSize + DATA_SEPARATOR > metaStart) throw new MmdbFormatError("search tree larger than file");
  const data = new Decoder(bytes, treeSize + DATA_SEPARATOR);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const record = (node: number, bit: number): number => {
    const off = node * nodeBytes;
    if (recordSize === 32) return view.getUint32(off + bit * 4, false);
    if (recordSize === 24) {
      const b = off + bit * 3;
      return (bytes[b]! << 16) | (bytes[b + 1]! << 8) | bytes[b + 2]!;
    }
    // 28-bit: the middle byte's nibbles extend the left/right records.
    const middle = bytes[off + 3]!;
    if (bit === 0) return (((middle & 0xf0) << 20) | (bytes[off]! << 16) | (bytes[off + 1]! << 8) | bytes[off + 2]!) >>> 0;
    return (((middle & 0x0f) << 24) | (bytes[off + 4]! << 16) | (bytes[off + 5]! << 8) | bytes[off + 6]!) >>> 0;
  };

  // IPv4 lookups in an IPv6 tree start after 96 zero bits.
  let ipv4Start = 0;
  if (ipVersion === 6) {
    for (let i = 0; i < 96 && ipv4Start < nodeCount; i++) ipv4Start = record(ipv4Start, 0);
  }
  const cache = new Map<number, MmdbValue>();

  return {
    metadata,
    get(ip) {
      if (ip.family === 6 && ipVersion === 4) return null;
      let node = ip.family === 4 && ipVersion === 6 ? ipv4Start : 0;
      const bits = ip.family === 4 ? 32 : 128;
      for (let i = 0; i < bits && node < nodeCount; i++) {
        const bit = Number((ip.value >> BigInt(bits - 1 - i)) & 1n);
        node = record(node, bit);
      }
      if (node === nodeCount) return null;
      if (node < nodeCount) return null;
      const offset = node - nodeCount - DATA_SEPARATOR;
      const hit = cache.get(offset);
      if (hit !== undefined) return hit;
      const [value] = data.decode(offset);
      if (cache.size < 100_000) cache.set(offset, value);
      return value;
    },
  };
}

/** Base + cumulative delta (research R3): delta first, `{removed: true}` means no data. */
export function overlay(base: Mmdb, delta: Mmdb | null): (ip: IpValue) => MmdbValue | null {
  return (ip) => {
    if (delta) {
      const hit = delta.get(ip);
      if (hit !== null) {
        return typeof hit === "object" && !Array.isArray(hit) && (hit as Record<string, MmdbValue>).removed === true ? null : hit;
      }
    }
    return base.get(ip);
  };
}
