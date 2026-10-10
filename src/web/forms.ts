import { equalText } from "./session";

/** Form posts of the admin panel and the site (spec 011 research R3, spec 012 contracts/site-http.md). */

export const MAX_FORM = 16_384;

/** A local path to return to after sign-in, never another site. */
export function safeReturn(value: string | null, fallback = "/"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || /[\r\n]/.test(value)) return fallback;
  return value;
}

/** Same origin and the session's CSRF token, for every change. */
export function postAllowed(request: Request, origin: string, csrf: string, form: URLSearchParams): boolean {
  if (request.headers.get("origin") !== origin) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  return equalText(form.get("csrf") ?? "", csrf);
}
