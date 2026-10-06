/**
 * HTML of the built-in challenge page (spec 006 research R8, contracts/challenge-http.md).
 * Everything is same-origin and nothing is cacheable; the CSP pins the one inline style by hash.
 */

const STYLE = `:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1c1c1a;--muted:#63635e;--card:#fff;--line:#e3e3de}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ececea;--muted:#a3a39d;--card:#1f1f1d;--line:#33332f}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;justify-items:center;align-content:start;padding:12vh 16px 16px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:28rem;width:100%;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px 24px}
h1{margin:0 0 8px;font-size:1.25rem;font-weight:600}p{margin:0 0 12px}.muted{color:var(--muted);font-size:.875rem;margin:16px 0 0}a{color:inherit}
#foxtrust-hold{display:block;width:100%;min-height:56px;margin:8px 0;border:2px solid var(--fg);border-radius:10px;background:var(--card);color:var(--fg);font:inherit;font-weight:600;cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none}
#foxtrust-hold:disabled{opacity:.5;cursor:default}#foxtrust-hold:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
#foxtrust-hold-progress{display:block;width:100%;height:8px}`;

const STYLE_HASH = new Bun.CryptoHasher("sha256").update(STYLE).digest("base64");

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "worker-src 'self'",
  `style-src 'sha256-${STYLE_HASH}'`,
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Headers on every response of the challenge routes. */
export const COMMON_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function pageHeaders(): Record<string, string> {
  return { ...COMMON_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP };
}

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The URL of a no-JavaScript answer: `<path>/wait?c=…&r=…` (not yet HTML-escaped). */
export function waitUrl(path: string, challenge: string, returnTo: string): string {
  return `${path}/wait?c=${encodeURIComponent(challenge)}&r=${encodeURIComponent(returnTo)}`;
}

function document(opts: { title: string; head?: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escape(opts.title)}</title>
<style>${STYLE}</style>
${opts.head ?? ""}</head>
<body>
<main>
${opts.body}
<p class="muted">This site checks some connections before letting them through. Nothing is stored about you except a short-lived pass cookie.</p>
</main>
</body>
</html>
`;
}

/** The press-and-hold control (spec 009 research R4): a real button, its help text, and a progress bar. */
const HOLD_MARKUP = `<button type="button" id="foxtrust-hold" aria-describedby="foxtrust-hold-help" disabled>Press and hold</button>
<progress id="foxtrust-hold-progress" max="1000" value="0" aria-label="Hold progress"></progress>
<p id="foxtrust-hold-help" class="muted">Hold the button, or Space or Enter, until the bar is full, then let go.</p>
`;

/** The challenge page: a proof-of-work form, plus the no-JavaScript path when it is on. */
export function renderChallengePage(opts: {
  path: string;
  challenge: string;
  nonce: string;
  bits: number;
  returnTo: string;
  wait: { challenge: string; seconds: number } | null;
  /** Show the press-and-hold step (spec 009). */
  hold?: boolean;
}): string {
  const noscript = opts.wait
    ? `<p>Your browser does not run JavaScript. You will be taken back in ${opts.wait.seconds} seconds.</p>`
    : `<p>JavaScript is needed to continue. Turn it on for this site and reload the page.</p>`;
  const refresh = opts.wait
    ? `<noscript><meta http-equiv="refresh" content="${opts.wait.seconds};url=${escape(waitUrl(opts.path, opts.wait.challenge, opts.returnTo))}"></noscript>\n`
    : "";
  return document({
    title: "Checking your browser",
    head: `${refresh}<script type="module" src="${escape(opts.path)}/page.js"></script>\n`,
    body: `<h1>Checking your browser</h1>
${opts.hold ? HOLD_MARKUP : ""}<p id="foxtrust-status" role="status" aria-live="polite">${opts.hold ? "One step: press and hold the button above." : "This takes a few seconds and needs nothing from you."}</p>
<form id="foxtrust-challenge" method="post" action="${escape(opts.path)}" data-n="${escape(opts.nonce)}" data-d="${opts.bits}" data-path="${escape(opts.path)}"${opts.hold ? " data-hold" : ""}>
<input type="hidden" name="c" value="${escape(opts.challenge)}">
<input type="hidden" name="s" value="">
<input type="hidden" name="p" value="">
<input type="hidden" name="b" value="">
<input type="hidden" name="r" value="${escape(opts.returnTo)}">
</form>
<noscript>${noscript}</noscript>`,
  });
}

/** A no-JavaScript answer that came too early: wait the rest, then retry the same answer. */
export function renderWaitPage(opts: { path: string; challenge: string; returnTo: string; remainingSeconds: number }): string {
  const url = waitUrl(opts.path, opts.challenge, opts.returnTo);
  return document({
    title: "Checking your browser",
    head: `<meta http-equiv="refresh" content="${opts.remainingSeconds};url=${escape(url)}">\n`,
    body: `<h1>Checking your browser</h1>
<p role="status">Please wait ${opts.remainingSeconds} more seconds. You will be taken back automatically.</p>`,
  });
}

/** An answer that could not be read at all. */
export function renderMalformed(): string {
  return document({
    title: "Request not understood",
    body: `<h1>Request not understood</h1>
<p>This check could not be completed. <a href="/">Go to the start page</a> and try again.</p>`,
  });
}

/** Refusal by the bot verdict (spec 007 FR-015): no reasons, only the way to dispute. */
export function renderBlocked(opts: { disputeUrl: string | null }): string {
  const dispute = opts.disputeUrl && /^https:\/\//i.test(opts.disputeUrl)
    ? `<p>If you think this is a mistake, <a href="${escape(opts.disputeUrl)}">tell us here</a>.</p>`
    : "<p>If you think this is a mistake, contact the site's operator.</p>";
  return document({
    title: "Access was refused",
    body: `<h1>Access was refused</h1>
<p>This connection looked automated, so it was not let through.</p>
${dispute}`,
  });
}

/** `foxtrust bot record` (spec 007 research R8): the probe only, posted to /record; never served by verify. */
export function renderRecorderPage(opts: { label: string; powNonce?: string; powBits?: number; hold?: boolean }): string {
  const pow = opts.powNonce && opts.powBits ? ` data-pow-n="${escape(opts.powNonce)}" data-pow-d="${opts.powBits}"` : "";
  return document({
    title: "Recording a sample",
    head: `<script type="module" src="/page.js"></script>\n`,
    body: `<h1>Recording a sample</h1>
${opts.hold ? HOLD_MARKUP : ""}<p id="foxtrust-status" role="status" aria-live="polite">Recording "${escape(opts.label)}"… this takes a moment.</p>
<form id="foxtrust-challenge" method="post" action="/record" data-n="*" data-record="1"${pow}${opts.hold ? " data-hold" : ""}>
<input type="hidden" name="p" value="">
<input type="hidden" name="b" value="">
<input type="hidden" name="tp" value="">
<input type="hidden" name="tw" value="">
</form>`,
  });
}

export function renderRecorded(opts: { file: string }): string {
  return document({ title: "Recorded", body: `<h1>Recorded</h1>\n<p>Saved as ${escape(opts.file)}.</p>` });
}
