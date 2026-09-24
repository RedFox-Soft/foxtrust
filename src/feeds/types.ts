import { formatCidr, parseCidr } from "../ip/cidr";

export type FeedKind = "network" | "category" | "behavior";

export type FeedFile = { name: string; body: Uint8Array };

export type NetworkEntry = { prefix: string; asn: number | null; org: string | null; country: string | null };
export type CategoryEntry = { prefix: string; code: string };
export type BehaviorEntry = { prefix: string; code: string; observedAt?: Date; confidence?: number };
export type ParsedEntry = NetworkEntry | CategoryEntry | BehaviorEntry;

export type ParseResult<E extends ParsedEntry = ParsedEntry> = { entries: E[]; invalidLines: number };

export type FeedLimits = {
  maxCompressedBytes: number;
  maxDecompressedBytes: number;
  maxEntries: number;
  timeoutMs: number;
  maxRedirects: number;
};

/** Defaults from research R14. */
export const DEFAULT_LIMITS: FeedLimits = {
  maxCompressedBytes: 50 * 1024 * 1024,
  maxDecompressedBytes: 500 * 1024 * 1024,
  maxEntries: 5_000_000,
  timeoutMs: 60_000,
  maxRedirects: 5,
};

export type FeedFileSpec = { name: string; url: string };

export type FeedDefinition = {
  id: string;
  kind: FeedKind;
  codes: string[];
  /** Cron expression (UTC). Must not be more frequent than the licence page's update_interval. */
  schedule: string;
  /** `feed`: entries carry their own observation time; `run`: the ingestion time is used. */
  timestamps: "run" | "feed";
  /** Files to download. `name` also matches `--from-file` inputs. */
  files: FeedFileSpec[];
  /** Resolves the real download URLs when they change (e.g. the newest CollecTor file). */
  resolveFiles?: (fetchText: (url: string) => Promise<string>) => Promise<FeedFileSpec[]>;
  limits?: Partial<FeedLimits>;
  parse(files: FeedFile[], fetchedAt: Date): ParseResult;
};

/** The whole feed content is unusable (FR-017: the run fails, stored data stays). */
export class FeedParseError extends Error {}

export const decodeText = (body: Uint8Array): string => new TextDecoder("utf-8", { fatal: false }).decode(body);

/** Canonical CIDR text (host bits cleared, IPv4-mapped unwrapped), or null when invalid. */
export function normaliseCidr(text: string): string | null {
  const cidr = parseCidr(text, { allowHostBits: true });
  return cidr === null ? null : formatCidr(cidr);
}

/** Lines without comments, blanks and surrounding whitespace. */
export function contentLines(text: string, comment = "#"): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith(comment));
}

/** Parses a list of one CIDR or address per line into entries with the same code. */
export function parsePrefixList(text: string, make: (prefix: string) => ParsedEntry): ParseResult {
  const entries: ParsedEntry[] = [];
  let invalidLines = 0;
  for (const line of contentLines(text)) {
    const prefix = normaliseCidr(line.split(/\s+/)[0]!);
    if (prefix === null) invalidLines++;
    else entries.push(make(prefix));
  }
  return { entries, invalidLines };
}
