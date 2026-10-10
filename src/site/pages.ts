import { escape } from "../web/html";
import type { Page } from "./content";

/**
 * Server-rendered pages of the public site (spec 012 contracts/site-http.md): no script, every value
 * escaped, Beer CSS and site.css from the site's own origin. Text pages come pre-rendered from
 * Markdown (content.ts); personal pages are built here.
 */

/** What a page knows about the visitor: nothing, or a signed-in customer. */
export type Visitor = { signInEnabled: boolean; session: { name: string; csrf: string } | null };

export function layout(opts: {
  title: string;
  body: string;
  visitor: Visitor;
  /** Public pages are indexable; personal and sign-in pages are not. */
  index: boolean;
  /** Text pages carry their own `# ` title in the Markdown. */
  heading?: boolean;
  notice?: string;
  error?: string;
}): string {
  const { visitor } = opts;
  const account = visitor.session
    ? `<a href="/account" class="button border"><i>person</i><span>${escape(visitor.session.name)}</span></a>`
    : visitor.signInEnabled
      ? `<a href="/auth/login" class="button"><i>login</i><span>Sign in</span></a>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.index ? "" : '<meta name="robots" content="noindex, nofollow">\n'}<title>${escape(opts.title)} · FoxTrust</title>
<link rel="stylesheet" href="/static/beercss/beer.min.css">
<link rel="stylesheet" href="/static/site.css">
</head>
<body>
<header class="surface-container">
<nav class="wrap">
<a href="/" class="max brand"><h6>FoxTrust</h6></a>
<a href="/docs/api" class="button transparent"><span>API</span></a>
<a href="/docs/snapshots" class="button transparent"><span>Snapshots</span></a>
<a href="/dispute" class="button transparent"><span>Dispute a listing</span></a>
${account}
</nav>
</header>
<main class="responsive">
${opts.notice ? `<article class="primary-container notice">${escape(opts.notice)}</article>` : ""}${opts.error ? `<article class="error-container error">${escape(opts.error)}</article>` : ""}
${opts.heading === false ? "" : `<h1>${escape(opts.title)}</h1>\n`}${opts.body}
</main>
<footer><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/dispute">Dispute a listing</a></footer>
</body>
</html>
`;
}

/** A text page rendered from Markdown; its own `# ` heading is the page heading. */
export const textPage = (page: Page, visitor: Visitor) =>
  layout({ title: page.title, body: `<article class="prose">${page.html}</article>`, visitor, index: true, heading: false });

export const messagePage = (title: string, text: string, visitor: Visitor, links = true) =>
  layout({
    title, visitor, index: false,
    body: `<p>${escape(text)}</p>${links ? '<p><a href="/">Home</a> · <a href="/dispute">Dispute a listing</a></p>' : ""}`,
  });

export const notFoundPage = (visitor: Visitor) => messagePage("Not found", "There is no page at this address.", visitor);

export const ROBOTS = "User-agent: *\nDisallow: /account\nDisallow: /auth\n";
