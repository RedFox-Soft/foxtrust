import { join } from "node:path";
import { keyId } from "../snapshot/sign";
import { escape } from "../web/html";
import type { SiteConfig } from "./config";

/**
 * The text pages of the site (spec 012 research R2): Markdown files rendered once at start with Bun's
 * built-in renderer, so public pages need neither the database nor foxauth. The dispute page is
 * `docs/dispute.md` itself (FR-002). No raw HTML from Markdown reaches a page, and values from the
 * configuration fill `{{name}}` placeholders, escaped.
 */

export const PAGES = ["landing", "api", "snapshots", "privacy", "terms"] as const;
export type PageName = (typeof PAGES)[number] | "dispute";
export type Page = { title: string; html: string };

export const CONTENT_DIR = join(import.meta.dir, "content");
export const DISPUTE_FILE = join(import.meta.dir, "..", "..", "docs", "dispute.md");

export class ContentError extends Error {}

const PLACEHOLDER = /\{\{([A-Za-z]+)\}\}/g;

/** Link targets a page may carry: local paths, fragments, http(s) and mail. */
const SAFE_URL = /^(?:\/(?!\/)|#|https?:\/\/|mailto:)/i;

/**
 * Markdown to HTML: GFM tables, autolinks (the dispute mailbox), heading ids. Raw HTML is not
 * rendered, and a link or image with another scheme (`javascript:`, `data:`) loses its target: the
 * renderer keeps such URLs, and the CSP is only the second line of defence.
 */
export function renderMarkdown(text: string): string {
  const html = Bun.markdown.html(text, { tables: true, autolinks: true, headings: { ids: true }, noHtmlBlocks: true, noHtmlSpans: true });
  return html.replace(/\s(href|src)="([^"]*)"/g, (all, attr: string, url: string) => (SAFE_URL.test(url) ? all : ` ${attr}="#"`));
}

function page(name: string, text: string, values: Record<string, string>): Page {
  const filled = text.replace(PLACEHOLDER, (all, key: string) => (key in values ? escape(values[key]) : all));
  const left = filled.match(PLACEHOLDER);
  if (left) throw new ContentError(`${name}: no value for ${left.join(", ")}`);
  const title = /^#\s+(.+)$/m.exec(filled)?.[1]?.trim();
  if (!title) throw new ContentError(`${name}: the page has no "# " title`);
  return { title, html: renderMarkdown(filled) };
}

/** The placeholder values that come from the configuration. */
export function contentValues(config: Pick<SiteConfig, "apiUrl" | "publicationUrl" | "trustedKeys" | "free">): Record<string, string> {
  const keys = config.trustedKeys.length
    ? config.trustedKeys.map((k) => `- key id \`${keyId(k)}\`: \`${k}\``).join("\n")
    : "- No key is published yet.";
  return {
    apiUrl: config.apiUrl,
    publicationUrl: config.publicationUrl,
    freeDaily: config.free.dailyQuota.toLocaleString("en-US"),
    freeBurst: String(config.free.burst),
    trustedKeys: keys,
  };
}

async function read(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new ContentError(`${path} is missing`);
  return file.text();
}

/** Every page, rendered; throws ContentError when a file is missing or a placeholder has no value. */
export async function loadContent(opts: { values: Record<string, string>; dir?: string; disputeFile?: string }): Promise<Record<PageName, Page>> {
  const dir = opts.dir ?? CONTENT_DIR;
  const out = {} as Record<PageName, Page>;
  for (const name of PAGES) out[name] = page(name, await read(join(dir, `${name}.md`)), opts.values);
  out.dispute = page("dispute", await read(opts.disputeFile ?? DISPUTE_FILE), opts.values);
  return out;
}
