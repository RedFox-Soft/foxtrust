/**
 * The return address after a passed challenge (spec 006 FR-005, research R7): always a path on
 * the protected host. Anything that could lead elsewhere becomes "/".
 */

export const MAX_RETURN_LENGTH = 2048;

/** Control characters, space, DEL, or a backslash (browsers treat "\" like "/"). */
const unsafeChar = (code: number) => code <= 0x20 || code === 0x7f || code === 0x5c;

const isLocalPath = (value: string) => {
  if (value.length > MAX_RETURN_LENGTH || !value.startsWith("/") || value[1] === "/") return false;
  for (let i = 0; i < value.length; i++) if (unsafeChar(value.charCodeAt(i))) return false;
  return true;
};

export function sanitizeReturn(value: string | null | undefined, requestHost: string | null): string {
  if (!value) return "/";
  if (isLocalPath(value)) return value;
  if (requestHost && /^https?:\/\//i.test(value) && value.length <= MAX_RETURN_LENGTH) {
    try {
      const url = new URL(value);
      if (url.host.toLowerCase() === requestHost.toLowerCase()) {
        const path = `${url.pathname}${url.search}`;
        if (isLocalPath(path)) return path;
      }
    } catch {
      // Not a URL: falls through to "/".
    }
  }
  return "/";
}
