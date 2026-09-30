import { BITS, type Cidr } from "../ip/cidr";

/**
 * MaxMind DB format 2.0 writer (https://maxmind.github.io/MaxMind-DB/), research R1.
 * - IPv6 tree, 32-bit records; IPv4 lives at ::/96 (the standard reader convention).
 * - Identical records are stored once in the data section.
 * - CIDRs must not overlap: callers flatten first (snapshot/ranges.ts); overlaps throw.
 */

export type MmdbValue = string | number | boolean | MmdbValue[] | { [key: string]: MmdbValue };

export type WriterOptions = {
  databaseType: string;
  description: Record<string, string>;
  languages?: string[];
  /** Map keys whose numeric values are always written as doubles (others: uint32 when integral). */
  doubleKeys?: string[];
  buildEpoch?: number;
};

const METADATA_MARKER = new Uint8Array([0xab, 0xcd, 0xef, ...new TextEncoder().encode("MaxMind.com")]);
const DATA_SEPARATOR = 16;
const EMPTY = 0; // record kinds in the trie: 0 = empty, >0 = child node + 1, <0 = -(data index + 1)

class ByteSink {
  private buf = new Uint8Array(1 << 16);
  length = 0;
  private ensure(extra: number) {
    if (this.length + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  byte(b: number) {
    this.ensure(1);
    this.buf[this.length++] = b;
  }
  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

const textEncoder = new TextEncoder();

function uintBytes(value: number | bigint, maxBytes: number): Uint8Array {
  let v = BigInt(value);
  const out: number[] = [];
  while (v > 0n) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  if (out.length > maxBytes) throw new Error(`value ${value} does not fit in ${maxBytes} bytes`);
  return new Uint8Array(out);
}

/** Control byte(s) for a type and payload size (spec: "Data Section Separator" / control byte). */
function control(sink: ByteSink, type: number, size: number) {
  const extended = type > 7;
  const typeBits = extended ? 0 : type << 5;
  let sizeBits: number;
  let sizeExtra: Uint8Array;
  if (size < 29) {
    sizeBits = size;
    sizeExtra = new Uint8Array();
  } else if (size < 29 + 256) {
    sizeBits = 29;
    sizeExtra = new Uint8Array([size - 29]);
  } else if (size < 285 + 65536) {
    sizeBits = 30;
    const s = size - 285;
    sizeExtra = new Uint8Array([s >> 8, s & 0xff]);
  } else {
    sizeBits = 31;
    const s = size - 65821;
    sizeExtra = new Uint8Array([(s >> 16) & 0xff, (s >> 8) & 0xff, s & 0xff]);
  }
  sink.byte(typeBits | sizeBits);
  if (extended) sink.byte(type - 7);
  sink.bytes(sizeExtra);
}

function encode(sink: ByteSink, value: MmdbValue, doubleKeys: Set<string>, key?: string): void {
  if (typeof value === "string") {
    const b = textEncoder.encode(value);
    control(sink, 2, b.length);
    sink.bytes(b);
  } else if (typeof value === "boolean") {
    control(sink, 14, value ? 1 : 0);
  } else if (typeof value === "number") {
    const asDouble = (key !== undefined && doubleKeys.has(key)) || !Number.isInteger(value) || value < 0 || value > 0xffffffff;
    if (asDouble) {
      control(sink, 3, 8);
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, value, false);
      sink.bytes(b);
    } else {
      const b = uintBytes(value, 4);
      control(sink, 6, b.length);
      sink.bytes(b);
    }
  } else if (Array.isArray(value)) {
    control(sink, 11, value.length);
    for (const item of value) encode(sink, item, doubleKeys);
  } else {
    const entries = Object.entries(value);
    control(sink, 7, entries.length);
    for (const [k, v] of entries) {
      encode(sink, k, doubleKeys);
      encode(sink, v, doubleKeys, k);
    }
  }
}

export class MmdbWriter {
  // Trie of nodes: left[i], right[i] hold record kinds (see EMPTY).
  private left = new Int32Array(1 << 16);
  private right = new Int32Array(1 << 16);
  private nodes = 1; // node 0 is the root
  private data = new ByteSink();
  private dataOffsets: number[] = [];
  private dedupe = new Map<string, number>();
  private readonly doubleKeys: Set<string>;

  constructor(private readonly options: WriterOptions) {
    this.doubleKeys = new Set(options.doubleKeys ?? []);
  }

  private grow() {
    const size = this.left.length * 2;
    const l = new Int32Array(size);
    const r = new Int32Array(size);
    l.set(this.left);
    r.set(this.right);
    this.left = l;
    this.right = r;
  }

  private newNode(): number {
    if (this.nodes >= this.left.length) this.grow();
    return this.nodes++;
  }

  private dataIndex(record: MmdbValue): number {
    const key = JSON.stringify(record);
    const known = this.dedupe.get(key);
    if (known !== undefined) return known;
    const index = this.dataOffsets.length;
    this.dataOffsets.push(this.data.length);
    encode(this.data, record, this.doubleKeys);
    this.dedupe.set(key, index);
    return index;
  }

  get recordCount(): number {
    return this.dataOffsets.length;
  }

  /** Inserts a CIDR (IPv4 is placed at ::/96). Throws when it overlaps an earlier insert. */
  insert(cidr: Cidr, record: MmdbValue): void {
    const value6 = cidr.family === 4 ? cidr.network : cidr.network;
    const length = cidr.family === 4 ? cidr.length + 96 : cidr.length;
    const bits = 128;
    const data = -(this.dataIndex(record) + 1);
    let node = 0;
    for (let depth = 0; depth < length; depth++) {
      const bit = Number((value6 >> BigInt(bits - 1 - depth)) & 1n);
      const side = bit === 0 ? this.left : this.right;
      const current = side[node]!;
      if (depth === length - 1) {
        if (current !== EMPTY) throw new Error(`overlapping insert at ${cidr.family === 4 ? "IPv4" : "IPv6"} depth ${depth}`);
        side[node] = data;
        return;
      }
      if (current < 0) throw new Error("overlapping insert: a shorter prefix already holds data");
      if (current === EMPTY) {
        const child = this.newNode();
        // `side` may be stale after grow(); write through the current arrays.
        (bit === 0 ? this.left : this.right)[node] = child + 1;
        node = child;
      } else {
        node = current - 1;
      }
    }
    if (length === 0) throw new Error("a zero-length prefix is not supported");
  }

  /**
   * Points ::ffff:0:0/96 at the IPv4 subtree (::/96), as MaxMind's own IPv6 databases do,
   * so standard readers find IPv4-mapped IPv6 addresses.
   */
  private aliasIpv4Mapped(): void {
    let v4 = 0;
    for (let depth = 0; depth < 96; depth++) {
      const next = this.left[v4]!;
      if (next <= 0) return; // no IPv4 data
      v4 = next - 1;
    }
    let node = 0;
    for (let depth = 0; depth < 80; depth++) node = this.left[node]! - 1;
    for (let depth = 80; depth < 96; depth++) {
      const last = depth === 95;
      const current = this.right[node]!;
      if (last) {
        if (current !== EMPTY) throw new Error("::ffff:0:0/96 already holds data");
        this.right[node] = v4 + 1;
        return;
      }
      if (current < 0) throw new Error("::ffff:0:0/96 already holds data");
      if (current === EMPTY) {
        const child = this.newNode();
        this.right[node] = child + 1;
        node = child;
      } else node = current - 1;
    }
  }

  build(): Uint8Array {
    this.aliasIpv4Mapped();
    const nodeCount = this.nodes;
    const out = new ByteSink();
    const rec = (kind: number): number => {
      if (kind === EMPTY) return nodeCount;
      if (kind > 0) return kind - 1;
      return nodeCount + DATA_SEPARATOR + this.dataOffsets[-kind - 1]!;
    };
    const node = new Uint8Array(8);
    const view = new DataView(node.buffer);
    for (let i = 0; i < nodeCount; i++) {
      view.setUint32(0, rec(this.left[i]!), false);
      view.setUint32(4, rec(this.right[i]!), false);
      out.bytes(node);
    }
    out.bytes(new Uint8Array(DATA_SEPARATOR));
    out.bytes(this.data.result());
    out.bytes(METADATA_MARKER);

    const metadata = new ByteSink();
    const epoch = this.options.buildEpoch ?? Math.floor(Date.now() / 1000);
    const md: [string, (s: ByteSink) => void][] = [
      ["binary_format_major_version", (s) => uint(s, 5, 2)],
      ["binary_format_minor_version", (s) => uint(s, 5, 0)],
      ["build_epoch", (s) => uint(s, 9, epoch)],
      ["database_type", (s) => encode(s, this.options.databaseType, this.doubleKeys)],
      ["description", (s) => encode(s, this.options.description, this.doubleKeys)],
      ["ip_version", (s) => uint(s, 5, 6)],
      ["languages", (s) => encode(s, this.options.languages ?? Object.keys(this.options.description), this.doubleKeys)],
      ["node_count", (s) => uint(s, 6, nodeCount)],
      ["record_size", (s) => uint(s, 5, 32)],
    ];
    control(metadata, 7, md.length);
    for (const [k, write] of md) {
      encode(metadata, k, this.doubleKeys);
      write(metadata);
    }
    out.bytes(metadata.result());
    return out.result();
  }
}

/** Unsigned integer of an explicit type (5 = uint16, 6 = uint32, 9 = uint64). */
function uint(sink: ByteSink, type: 5 | 6 | 9, value: number) {
  const b = uintBytes(value, type === 5 ? 2 : type === 6 ? 4 : 8);
  control(sink, type, b.length);
  sink.bytes(b);
}
