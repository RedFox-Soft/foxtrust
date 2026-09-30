import { startPublicationServer } from "../../publication/server";
import { EXIT, printLine, rejectUnknown, takeOption, UsageError, type Context } from "../util";
import { publicationDir } from "./keys";

/** `publication serve [--dir] [--port]`: read-only static server (contracts/publication.md). */
export async function publicationServe(args: string[], _ctx: Context): Promise<number> {
  const [dir = publicationDir()] = takeOption(args, "--dir");
  const [portText = "8081"] = takeOption(args, "--port");
  rejectUnknown(args);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("--port must be a port number");
  const server = startPublicationServer({ dir, port });
  printLine(`Publication served from ${dir} on port ${server.port}.`);
  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await server.stop();
  return EXIT.ok;
}
