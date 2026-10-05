import type { Server } from "bun";
import type { EnabledAlertSettings } from "../../src/alerts/settings";

export type FakeMode = "accept" | "http500" | "unauthorized" | "tooMany" | "hang" | "closed";

export type FakeTelegram = {
  url: string;
  /** Every request received: path and JSON body. */
  requests: { path: string; body: { chat_id?: string; text?: string } }[];
  /** Texts of the messages that were accepted. */
  accepted: () => string[];
  setMode: (mode: FakeMode) => Promise<void>;
  /** Forgets every request and accepts again (between scenarios). */
  reset: () => Promise<void>;
  stop: () => Promise<void>;
};

/** A local stand-in for the Telegram Bot API with switchable failures (research R8). */
export function startFakeTelegram(): FakeTelegram {
  let mode: FakeMode = "accept";
  const requests: FakeTelegram["requests"] = [];
  const acceptedTexts: string[] = [];
  const handler = async (req: Request): Promise<Response> => {
    const body = (await req.json().catch(() => ({}))) as { chat_id?: string; text?: string };
    requests.push({ path: new URL(req.url).pathname, body });
    switch (mode) {
      case "http500":
        return new Response("upstream failure", { status: 500 });
      case "unauthorized":
        return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
      case "tooMany":
        return Response.json({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 30 } }, { status: 429 });
      case "hang":
        return new Promise<Response>(() => {});
      default:
        acceptedTexts.push(body.text ?? "");
        return Response.json({ ok: true, result: { message_id: requests.length } });
    }
  };
  let server: Server<undefined> | null = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  const port = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    accepted: () => [...acceptedTexts],
    async setMode(next) {
      mode = next;
      if (next === "closed" && server) {
        await server.stop(true);
        server = null;
      } else if (next !== "closed" && !server) {
        server = Bun.serve({ port, hostname: "127.0.0.1", fetch: handler });
      }
    },
    async reset() {
      requests.length = 0;
      acceptedTexts.length = 0;
      await this.setMode("accept");
    },
    async stop() {
      await server?.stop(true);
      server = null;
    },
  };
}

export const TEST_TOKEN = "123456789:AAFoxTrustTestTokenValue_x9";

export function settingsFor(fake: FakeTelegram, token = TEST_TOKEN, chatId = "-1001234567890"): EnabledAlertSettings {
  return { enabled: true, token, chatId, apiUrl: fake.url };
}
