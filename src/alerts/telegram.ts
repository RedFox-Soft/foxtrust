import { createRedactor, errorText } from "./redact";
import type { EnabledAlertSettings } from "./settings";

export const SEND_TIMEOUT_MS = 10_000;

export type SendResult =
  | { ok: true }
  | {
      ok: false;
      /** Redacted, for logs and CLI output. */
      reason: string;
      status: number | null;
      retryAfterSeconds: number | null;
      /** The bot token or the chat was refused: retrying will not help until the settings change. */
      rejected: boolean;
    };

type ApiAnswer = { ok: boolean | null; errorCode: number | null; description: string | null; retryAfter: number | null };

function readAnswer(body: unknown): ApiAnswer {
  const answer: ApiAnswer = { ok: null, errorCode: null, description: null, retryAfter: null };
  if (typeof body !== "object" || body === null) return answer;
  const record = body as Record<string, unknown>;
  if (typeof record.ok === "boolean") answer.ok = record.ok;
  if (typeof record.error_code === "number") answer.errorCode = record.error_code;
  if (typeof record.description === "string") answer.description = record.description;
  const parameters = record.parameters;
  if (typeof parameters === "object" && parameters !== null) {
    const retryAfter = (parameters as Record<string, unknown>).retry_after;
    if (typeof retryAfter === "number" && retryAfter > 0) answer.retryAfter = retryAfter;
  }
  return answer;
}

/** Research R3: one `sendMessage` attempt, plain text, link previews off, bounded in time. */
export async function sendTelegram(
  settings: EnabledAlertSettings,
  text: string,
  opts: { timeoutMs?: number } = {},
): Promise<SendResult> {
  const redact = createRedactor(settings.token);
  const timeoutMs = opts.timeoutMs ?? SEND_TIMEOUT_MS;
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(`${settings.apiUrl}/bot${settings.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: settings.chatId, text, link_preview_options: { is_disabled: true } }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await response.json().catch(() => null);
  } catch (error) {
    const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      reason: timedOut ? `no answer within ${timeoutMs / 1000} s` : `cannot reach Telegram: ${errorText(error, redact)}`,
      status: null,
      retryAfterSeconds: null,
      rejected: false,
    };
  }
  const answer = readAnswer(body);
  if (response.ok && answer.ok === true) return { ok: true };
  const status = answer.errorCode ?? response.status;
  return {
    ok: false,
    reason: redact(`HTTP ${response.status}${answer.description ? `: ${answer.description}` : ""}`),
    status,
    retryAfterSeconds: answer.retryAfter,
    rejected: status === 400 || status === 401 || status === 403 || status === 404,
  };
}
