export type EnabledAlertSettings = { enabled: true; token: string; chatId: string; apiUrl: string };
export type AlertSettings = EnabledAlertSettings | { enabled: false; reason: string; invalid: boolean };

export const DEFAULT_TELEGRAM_API_URL = "https://api.telegram.org";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const disabled = (reason: string, invalid = false): AlertSettings => ({ enabled: false, reason, invalid });

/**
 * Research R4: the Telegram bot token (from `FOXTRUST_TELEGRAM_BOT_TOKEN_FILE`, else
 * `FOXTRUST_TELEGRAM_BOT_TOKEN`), the chat id and the API base URL. Alerts are off unless both a
 * token and a chat id are set. No `reason` ever contains the token.
 */
export async function readAlertSettings(env: Record<string, string | undefined> = Bun.env): Promise<AlertSettings> {
  let token = env.FOXTRUST_TELEGRAM_BOT_TOKEN?.trim() || null;
  const tokenFile = env.FOXTRUST_TELEGRAM_BOT_TOKEN_FILE?.trim();
  if (tokenFile) {
    try {
      token = (await Bun.file(tokenFile).text()).trim() || null;
    } catch {
      return disabled(`FOXTRUST_TELEGRAM_BOT_TOKEN_FILE ${tokenFile} is not readable`, true);
    }
  }
  const chatId = env.FOXTRUST_TELEGRAM_CHAT_ID?.trim() || null;
  if (!token && !chatId) return disabled("FOXTRUST_TELEGRAM_BOT_TOKEN and FOXTRUST_TELEGRAM_CHAT_ID are not set");
  if (!token) return disabled("FOXTRUST_TELEGRAM_BOT_TOKEN is not set", true);
  if (!chatId) return disabled("FOXTRUST_TELEGRAM_CHAT_ID is not set", true);
  // A token with whitespace could split a log line around a redaction.
  if (/\s/.test(token)) return disabled("the bot token contains whitespace", true);
  if (!/^-?\d+$/.test(chatId) && !/^@\w{5,}$/.test(chatId)) {
    return disabled("FOXTRUST_TELEGRAM_CHAT_ID must be a number or an @username", true);
  }

  const rawUrl = env.FOXTRUST_TELEGRAM_API_URL?.trim() || DEFAULT_TELEGRAM_API_URL;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return disabled("FOXTRUST_TELEGRAM_API_URL is not a URL", true);
  }
  const loopbackHttp = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) {
    return disabled("FOXTRUST_TELEGRAM_API_URL must use https (http only for loopback hosts)", true);
  }
  return { enabled: true, token, chatId, apiUrl: rawUrl.replace(/\/+$/, "") };
}
