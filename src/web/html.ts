/**
 * HTML building blocks shared by the admin panel and the site (spec 011 research R3, spec 012 R1,
 * R7): no script at all, every value escaped, confirmations as pages of their own. Each service
 * wraps these in its own layout.
 */

export const CSP =
  "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** Headers of every HTML answer. Public pages may be cached briefly; everything else is `no-store`. */
export function pageHeaders(cache: "no-store" | "public" = "no-store"): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": CSP,
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": cache === "public" ? "public, max-age=300" : "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

export function escape(value: string | number | null | undefined): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${escape(csrf)}">`;

/** A Beer CSS outlined field; the control needs `placeholder=" "` so the label floats without script. */
export const field = (label: string, control: string) => `<div class="field label border">${control}<label>${escape(label)}</label></div>`;

/** The body of a confirmation page: a form that posts the action. */
export function confirmBody(csrf: string, opts: { text: string; action: string; button: string; danger?: boolean; fields?: string; cancel?: string }): string {
  return `<article class="${opts.danger ? "error-container" : "secondary-container"}"><p>${escape(opts.text)}</p>
<form method="post" action="${escape(opts.action)}" class="stack">${csrfField(csrf)}${opts.fields ?? ""}
<nav><button type="submit"${opts.danger ? ' class="error"' : ""}>${escape(opts.button)}</button><a class="button border" href="${escape(opts.cancel ?? "/")}">Cancel</a></nav>
</form></article>`;
}

/** The body of the only page that ever shows a key's secret: the answer to its creation, not cached. */
export function secretBody(key: string): string {
  return `<article class="tertiary-container"><p><i>warning</i> Copy this key now. It is shown only once; FoxTrust keeps only a hash of it.</p>
<code class="secret">${escape(key)}</code></article>`;
}
