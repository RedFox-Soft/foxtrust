export type Redact = (text: string) => string;

export const REDACTED = "<redacted>";

/**
 * FR-011: replaces the bot token, plain and URL-encoded, in every string that leaves the alert
 * module. `fetch` errors can carry the request URL, and that URL contains the token.
 */
export function createRedactor(secret: string | null | undefined): Redact {
  if (!secret) return (text) => text;
  const forms = [...new Set([secret, encodeURIComponent(secret)])];
  return (text) => forms.reduce((out, form) => out.split(form).join(REDACTED), text);
}

/** The message of any thrown value, redacted. */
export function errorText(error: unknown, redact: Redact): string {
  return redact(error instanceof Error ? error.message : String(error));
}
