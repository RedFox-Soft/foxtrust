import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { formatCidr } from "../../ip/cidr";
import type { IpValue } from "../../ip/parse";
import { hmac, passNetwork } from "../token";

/**
 * Revocations and address caps of returning-device tokens (spec 008 research R4), per `verify`
 * instance, kept in memory and in a small JSON file so revocations survive restarts. It never holds
 * an address: only keyed hashes of the pass prefix (/32 or /64), and only for 24 hours.
 */

const DAY = 86_400;
const SAVE_DELAY_MS = 5_000;

type Entry = { revokedUntil?: number; prefixes: Map<string, number>; lastSeen: number };

export type DeviceStore = {
  isRevoked(id: string, now: number): boolean;
  /** True when this address prefix is already counted for the token, or the cap still has room. */
  allows(id: string, ip: IpValue, now: number): boolean;
  record(id: string, ip: IpValue, now: number): void;
  revoke(id: string, exp: number, now: number): void;
  counts(now: number): { tracked: number; revoked: number };
  load(): Promise<void>;
  scheduleSave(): void;
  flush(): Promise<void>;
};

export class DeviceStateError extends Error {}

export function createDeviceStore(opts: { file: string; secret: string; cap: number; maxTokens?: number }): DeviceStore {
  const maxTokens = opts.maxTokens ?? 100_000;
  const key = Buffer.from(hmac("foxtrust-device-prefix/1", opts.secret)).toString("hex");
  const entries = new Map<string, Entry>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  const prefixKey = (ip: IpValue) => Buffer.from(hmac(`${ip.family}:${formatCidr(passNetwork(ip))}`, key)).toString("hex").slice(0, 16);

  function prune(entry: Entry, now: number) {
    for (const [prefix, seen] of entry.prefixes) if (seen <= now - DAY) entry.prefixes.delete(prefix);
    if (entry.revokedUntil !== undefined && entry.revokedUntil <= now) delete entry.revokedUntil;
  }

  function entryOf(id: string, now: number): Entry {
    let entry = entries.get(id);
    if (!entry) {
      if (entries.size >= maxTokens) evict(now);
      entry = { prefixes: new Map(), lastSeen: now };
      entries.set(id, entry);
    }
    entry.lastSeen = now;
    return entry;
  }

  /** Drops the least recently active entries that hold no live revocation. */
  function evict(now: number) {
    const candidates = [...entries].filter(([, e]) => e.revokedUntil === undefined || e.revokedUntil <= now).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [id] of candidates.slice(0, Math.max(1, Math.ceil(maxTokens / 100)))) entries.delete(id);
  }

  const store: DeviceStore = {
    isRevoked(id, now) {
      const entry = entries.get(id);
      return entry?.revokedUntil !== undefined && entry.revokedUntil > now;
    },
    allows(id, ip, now) {
      const entry = entries.get(id);
      if (!entry) return opts.cap > 0;
      prune(entry, now);
      return entry.prefixes.has(prefixKey(ip)) || entry.prefixes.size < opts.cap;
    },
    record(id, ip, now) {
      const entry = entryOf(id, now);
      prune(entry, now);
      entry.prefixes.set(prefixKey(ip), now);
      store.scheduleSave();
    },
    revoke(id, exp, now) {
      const entry = entryOf(id, now);
      entry.revokedUntil = exp;
      entry.prefixes.clear();
      store.scheduleSave();
    },
    counts(now) {
      let revoked = 0;
      for (const entry of entries.values()) if (entry.revokedUntil !== undefined && entry.revokedUntil > now) revoked++;
      return { tracked: entries.size, revoked };
    },
    async load() {
      const file = Bun.file(opts.file);
      if (!(await file.exists())) return;
      let value: unknown;
      try {
        value = JSON.parse(await file.text());
      } catch {
        throw new DeviceStateError(`${opts.file}: not valid JSON`);
      }
      const tokens = (value as { v?: unknown; tokens?: unknown } | null)?.tokens;
      if ((value as { v?: unknown } | null)?.v !== 1 || typeof tokens !== "object" || tokens === null) {
        throw new DeviceStateError(`${opts.file}: not a device state file (v 1)`);
      }
      for (const [id, raw] of Object.entries(tokens as Record<string, unknown>)) {
        if (typeof raw !== "object" || raw === null) continue;
        const { revokedUntil, prefixes } = raw as { revokedUntil?: unknown; prefixes?: unknown };
        const entry: Entry = { prefixes: new Map(), lastSeen: 0 };
        if (typeof revokedUntil === "number") entry.revokedUntil = revokedUntil;
        if (typeof prefixes === "object" && prefixes !== null) {
          for (const [prefix, seen] of Object.entries(prefixes as Record<string, unknown>)) {
            if (/^[0-9a-f]{16}$/.test(prefix) && typeof seen === "number") {
              entry.prefixes.set(prefix, seen);
              entry.lastSeen = Math.max(entry.lastSeen, seen);
            }
          }
        }
        entries.set(id, entry);
      }
    },
    scheduleSave() {
      dirty = true;
      timer ??= setTimeout(() => {
        timer = null;
        void store.flush();
      }, SAVE_DELAY_MS);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!dirty) return;
      dirty = false;
      const now = Math.floor(Date.now() / 1000);
      const tokens: Record<string, { revokedUntil?: number; prefixes: Record<string, number> }> = {};
      for (const [id, entry] of entries) {
        prune(entry, now);
        if (entry.revokedUntil === undefined && entry.prefixes.size === 0) {
          entries.delete(id);
          continue;
        }
        tokens[id] = { ...(entry.revokedUntil === undefined ? {} : { revokedUntil: entry.revokedUntil }), prefixes: Object.fromEntries(entry.prefixes) };
      }
      await mkdir(dirname(opts.file), { recursive: true });
      const tmp = `${opts.file}.tmp`;
      await Bun.write(tmp, JSON.stringify({ v: 1, savedAt: now, tokens }));
      await rename(tmp, opts.file);
    },
  };
  return store;
}
