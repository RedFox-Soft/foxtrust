import type { Account, KeyInfo, UsageDay } from "../api/accounts";
import type { AuditRecord } from "./audit";
import type { FeedView, Overview, ReleaseView, RunView } from "./data";
import type { OperatorRequest } from "./requests";
import { confirmBody, csrfField as csrfInput, escape, field, secretBody } from "../web/html";

/**
 * Server-rendered pages of the admin panel (spec 011 research R3): no script at all, every value
 * escaped, confirmations as pages of their own. Styles: Beer CSS (Material Design 3, MIT, package
 * `beercss`), served from the panel's own origin with its icon font, plus a few local rules in admin.css. Beer CSS needs no
 * script: the theme follows the device, and field labels float through `placeholder=" "`.
 */

export { CSP, escape, field, pageHeaders } from "../web/html";

const when = (d: Date | null | undefined) => (d ? `${new Date(d).toISOString().slice(0, 16).replace("T", " ")} UTC` : "—");
const age = (d: Date, now: Date) => {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(d).getTime()) / 60_000));
  return minutes < 60 ? `${minutes} min` : minutes < 2880 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`;
};
const cls = (status: string) => `status-${escape(status)}`;

export type PageSession = { name: string; csrf: string };
const NAV = [
  ["/", "Overview", "dashboard"], ["/accounts", "Accounts", "group"], ["/keys", "Keys", "key"],
  ["/releases", "Releases", "inventory_2"], ["/feeds", "Feeds", "rss_feed"], ["/audit", "Audit", "history"],
] as const;

export const csrfField = (s: PageSession) => csrfInput(s.csrf);

export function layout(opts: { title: string; session: PageSession | null; body: string; current?: string; notice?: string; error?: string }): string {
  const nav = opts.session
    ? `<nav class="wrap">
<a href="/" class="max"><h6>FoxTrust admin</h6></a>
${NAV.map(([href, label, icon]) => `<a href="${href}" class="button ${opts.current === href ? "fill current" : "transparent"}"><i>${icon}</i><span>${label}</span></a>`).join("\n")}
<form method="post" action="/auth/logout" class="inline">${csrfField(opts.session)}<button type="submit" class="border"><i>logout</i><span>${escape(opts.session.name)}</span></button></form>
</nav>`
    : `<h6 class="brand">FoxTrust admin</h6>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escape(opts.title)} · FoxTrust admin</title>
<link rel="stylesheet" href="/static/beercss/beer.min.css">
<link rel="stylesheet" href="/static/admin.css">
</head>
<body>
<header class="surface-container">${nav}</header>
<main class="responsive">
${opts.notice ? `<article class="primary-container notice">${escape(opts.notice)}</article>` : ""}${opts.error ? `<article class="error-container error">${escape(opts.error)}</article>` : ""}
<h1>${escape(opts.title)}</h1>
${opts.body}
</main>
</body>
</html>
`;
}

/** A page without a session: sign-in unavailable, not allowed, sign-in failed. */
export const messagePage = (title: string, text: string, link = true) =>
  layout({ title, session: null, body: `<p>${escape(text)}</p>${link ? '<p><a href="/auth/login">Sign in again</a></p>' : ""}` });

const table = (head: string[], rows: string[][]) =>
  `<div class="scroll"><table class="stripes"><thead><tr>${head.map((h) => `<th>${escape(h)}</th>`).join("")}</tr></thead><tbody>${
    rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${head.length}" class="muted">None.</td></tr>`
  }</tbody></table></div>`;

const pager = (path: string, page: number, full: boolean) =>
  page > 0 || full
    ? `<nav class="pager">${page > 0 ? `<a class="button border" href="${path}?page=${page - 1}"><i>chevron_left</i><span>Newer</span></a>` : ""}${full ? `<a class="button border" href="${path}?page=${page + 1}"><span>Older</span><i>chevron_right</i></a>` : ""}</nav>`
    : "";

/** A confirmation page whose form posts the action. */
export function confirmPage(
  s: PageSession, opts: { title: string; text: string; action: string; button: string; danger?: boolean; fields?: string; error?: string; cancel?: string },
): string {
  return layout({ title: opts.title, session: s, ...(opts.error ? { error: opts.error } : {}), body: confirmBody(s.csrf, opts) });
}

const requestLine = (r: OperatorRequest, now: Date) =>
  `<span class="${cls(r.state)}">${escape(r.state)}</span> by ${escape(r.requestedBy)}, ${escape(age(r.requestedAt, now))} ago${r.result ? ` — ${escape(r.result)}` : ""}`;

export function overviewPage(s: PageSession, o: Overview, now: Date): string {
  return layout({
    title: "Overview", session: s, current: "/",
    body: `<h2>Open alerts</h2>${table(["problem", "since", "subject"], o.alerts.map((a) => [escape(a.key), escape(when(a.openedAt)), escape(a.subject)]))}
<h2>Held feed runs</h2>${table(["feed", "run", "started", "entries", "before", ""], o.heldRuns.map((r) => [
      escape(r.feedId), String(r.id), escape(when(r.startedAt)), String(r.entryCount ?? "—"), String(r.previousEntryCount ?? "—"), `<a href="/feeds/runs/${r.id}/confirm">Confirm…</a>`,
    ]))}
<h2>Stale feeds</h2>${table(["feed", "last success"], o.staleFeeds.map((f) => [escape(f.id), escape(when(f.lastSuccessAt))]))}
<h2>Held releases</h2>${table(["version", "kind", "built", ""], o.heldReleases.map((r) => [
      `<a href="/releases#${escape(r.version)}">${escape(r.version)}</a>`, escape(r.kind), escape(when(r.builtAt)),
      r.pending ? "release requested" : `<a href="/releases/${escape(r.version)}/confirm">Release…</a>`,
    ]))}
<h2>Pending requests</h2>${table(["kind", "item", "waiting"], o.pending.map((r) => [escape(r.kind), escape(r.target), `${escape(age(r.requestedAt, now))} (by ${escape(r.requestedBy)})`]))}`,
  });
}

export function accountsPage(s: PageSession, accounts: Account[], page: number, full: boolean, form: { name?: string; contact?: string; error?: string } = {}): string {
  return layout({
    title: "Accounts", session: s, current: "/accounts", ...(form.error ? { error: form.error } : {}),
    body: `${table(["account", "name", "contact", "keys", "created", "state"], accounts.map((a) => [
      `<a href="/accounts/${escape(a.id)}"><code>${escape(a.id)}</code></a>`, escape(a.name), escape(a.contact), String(a.keyCount), escape(when(a.createdAt)),
      a.disabledAt ? `<span class="status-disabled">disabled ${escape(when(a.disabledAt))}</span>` : "active",
    ]))}${pager("/accounts", page, full)}
<h2>New account</h2>
<form method="post" action="/accounts" class="stack">${csrfField(s)}
${field("Name", `<input type="text" name="name" maxlength="200" required placeholder=" " value="${escape(form.name)}">`)}
${field("Contact", `<input type="text" name="contact" maxlength="320" required placeholder=" " value="${escape(form.contact)}">`)}
<nav><button type="submit"><i>person_add</i><span>Create account</span></button></nav></form>`,
  });
}

const keyRow = (k: KeyInfo) => [
  `<a href="/keys/${escape(k.id)}" class="key">${escape(k.display)}</a>`, `<a href="/accounts/${escape(k.accountId)}"><code>${escape(k.accountId)}</code></a>`,
  escape(k.label), escape(k.tier), `${k.dailyQuota}/day, ${k.burst}/s`, escape(when(k.createdAt)), escape(when(k.lastUsedAt)),
  k.revokedAt ? `<span class="status-revoked">revoked</span>` : "active", String(k.answeredToday), String(k.answeredLast7Days),
];
const KEY_HEAD = ["key", "account", "label", "tier", "limits", "created", "last used", "state", "today", "7 days"];

export function accountPage(s: PageSession, a: Account, keys: KeyInfo[], form: { label?: string; error?: string } = {}): string {
  return layout({
    title: `Account ${a.name}`, session: s, current: "/accounts", ...(form.error ? { error: form.error } : {}),
    body: `<article><p><code>${escape(a.id)}</code> · ${escape(a.contact)} · created ${escape(when(a.createdAt))}</p>
<p>${a.disabledAt ? `<span class="status-disabled">Disabled ${escape(when(a.disabledAt))}</span>` : `<a class="button border error-text" href="/accounts/${escape(a.id)}/disable/confirm"><i>block</i><span>Disable account…</span></a>`}</p></article>
<h2>Keys</h2>${table(KEY_HEAD, keys.map(keyRow))}
${a.disabledAt ? "" : `<h2>Issue a key</h2>
<form method="post" action="/accounts/${escape(a.id)}/keys" class="stack">${csrfField(s)}
${field("Label", `<input type="text" name="label" maxlength="100" placeholder=" " value="${escape(form.label)}">`)}
${field("Daily quota (empty: tier default)", `<input type="number" name="dailyQuota" min="1" max="10000000" placeholder=" ">`)}
${field("Burst per second (empty: tier default)", `<input type="number" name="burst" min="1" max="1000" placeholder=" ">`)}
<nav><button type="submit"><i>vpn_key</i><span>Issue key</span></button></nav></form>`}`,
  });
}

/** The only page that ever shows a key's secret: the answer to its creation, not cached. */
export function secretPage(s: PageSession, key: string, info: KeyInfo): string {
  return layout({
    title: "New API key", session: s, current: "/keys",
    body: `${secretBody(key)}
<p><a href="/keys/${escape(info.id)}">Key ${escape(info.display)}</a> · <a href="/accounts/${escape(info.accountId)}">Account</a></p>`,
  });
}

export function keysPage(s: PageSession, keys: KeyInfo[], page: number, full: boolean): string {
  return layout({ title: "API keys", session: s, current: "/keys", body: `${table(KEY_HEAD, keys.map(keyRow))}${pager("/keys", page, full)}` });
}

export function keyPage(s: PageSession, k: KeyInfo, usage: UsageDay[], form: { error?: string; notice?: string } = {}): string {
  return layout({
    title: `Key ${k.display}`, session: s, current: "/keys", ...(form.error ? { error: form.error } : {}), ...(form.notice ? { notice: form.notice } : {}),
    body: `<article><p>Account <a href="/accounts/${escape(k.accountId)}"><code>${escape(k.accountId)}</code></a> · label ${escape(k.label || "—")} · tier ${escape(k.tier)}</p>
<p>Limits: ${k.dailyQuota}/day${k.overrides.dailyQuota === null ? " (default)" : ""}, ${k.burst}/s${k.overrides.burst === null ? " (default)" : ""}</p>
<p>Created ${escape(when(k.createdAt))} · last used ${escape(when(k.lastUsedAt))} · ${k.revokedAt ? `<span class="status-revoked">revoked ${escape(when(k.revokedAt))}</span>` : `<a class="button border error-text" href="/keys/${escape(k.id)}/revoke/confirm"><i>key_off</i><span>Revoke…</span></a>`}</p></article>
<h2>Usage (30 days)</h2>${table(["day (UTC)", "answered", "invalid", "limited"], [...usage].reverse().map((d) => [escape(d.day), String(d.answered), String(d.invalid), String(d.limited)]))}
${k.revokedAt ? "" : `<h2>Limits</h2>
<form method="post" action="/keys/${escape(k.id)}/limits" class="stack">${csrfField(s)}
${field("Daily quota (empty: tier default)", `<input type="number" name="dailyQuota" min="1" max="10000000" placeholder=" " value="${k.overrides.dailyQuota ?? ""}">`)}
${field("Burst per second (empty: tier default)", `<input type="number" name="burst" min="1" max="1000" placeholder=" " value="${k.overrides.burst ?? ""}">`)}
<nav><button type="submit"><i>save</i><span>Save limits</span></button></nav></form>`}`,
  });
}

export function releasesPage(s: PageSession, list: ReleaseView[], requests: OperatorRequest[], page: number, full: boolean, now: Date): string {
  return layout({
    title: "Releases", session: s, current: "/releases",
    body: `${table(["version", "kind", "built", "status", "details", ""], list.map((r) => [
      `<span id="${escape(r.version)}">${escape(r.version)}</span>`, escape(r.kind), escape(when(r.builtAt)), `<span class="${cls(r.status)}">${escape(r.status)}</span>`,
      [...r.regressions.map((x) => `regression: ${escape(x)}`), ...r.problems.map((x) => `problem: ${escape(x)}`), ...(r.releaseNote ? [`note: ${escape(r.releaseNote)}`] : [])].join("<br>"),
      r.status !== "held" ? "" : r.pending ? "release requested" : `<a href="/releases/${escape(r.version)}/confirm">Release…</a>`,
    ]))}${pager("/releases", page, full)}
<h2>Requests</h2>${table(["kind", "item", "note", "state"], requests.map((r) => [escape(r.kind), escape(r.target), escape(r.note ?? ""), requestLine(r, now)]))}`,
  });
}

export function feedsPage(s: PageSession, list: FeedView[], now: Date): string {
  const run = (r: RunView | null) => (r ? `<span class="${cls(r.status)}">${escape(r.status)}</span> ${escape(when(r.startedAt))}` : "—");
  return layout({
    title: "Feeds", session: s, current: "/feeds",
    body: table(["feed", "last run", "entries", "before", "stale", "enabled", "last error", ""], list.map((f) => [
      escape(f.id), run(f.lastRun), String(f.lastRun?.entryCount ?? "—"), String(f.lastRun?.previousEntryCount ?? "—"),
      f.stale ? `<span class="status-held">stale</span>` : "no", f.enabled ? "yes" : "no", escape(f.lastError ?? ""),
      f.lastRun?.status !== "held" ? "" : f.pending ? `confirmation requested (${escape(age(f.pending.requestedAt, now))})` : `<a href="/feeds/runs/${f.lastRun.id}/confirm">Confirm…</a>`,
    ])),
  });
}

export function auditPage(s: PageSession, records: AuditRecord[]): string {
  return layout({
    title: "Audit", session: s, current: "/audit",
    body: table(["time", "operator", "action", "item", "note", "details"], records.map((r) => [
      escape(when(r.at)), escape(r.name), escape(r.action), escape(r.item ?? ""), escape(r.note ?? ""),
      Object.keys(r.details).length ? `<code>${escape(JSON.stringify(r.details))}</code>` : "",
    ])),
  });
}
