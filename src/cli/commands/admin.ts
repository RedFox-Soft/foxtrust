import { SQL } from "bun";
import { AdminConfigError, readAdminConfig } from "../../admin/config";
import { createOidc, OidcConfigError } from "../../admin/oidc";
import { startAdminServer } from "../../admin/server";
import { createAccounts } from "../../api/accounts";
import { EXIT, printLine, rejectUnknown, UsageError, warn, type Context } from "../util";

/**
 * `admin serve`: the operator admin panel (spec 011). It must not listen on a host port; the tunnel
 * reaches it on the compose network. An unreachable foxauth does not stop it: existing sessions keep
 * working and sign-in retries (contracts/admin-http.md).
 */
export async function adminServe(args: string[], _ctx: Context): Promise<number> {
  rejectUnknown(args);
  let config;
  try {
    config = readAdminConfig();
  } catch (error) {
    if (error instanceof AdminConfigError) throw new UsageError(error.message);
    throw error;
  }
  const oidc = createOidc({ issuer: config.issuer, clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: `${config.url}/auth/callback` });
  try {
    await oidc.ready();
  } catch (error) {
    if (error instanceof OidcConfigError) throw new UsageError(`FOXTRUST_ADMIN_ISSUER: ${error.message}`);
    warn(`admin: foxauth is not reachable yet (${(error as Error).message}); sign-in retries on each attempt`);
  }
  const sql = new SQL(config.databaseUrl, { max: 4 });
  const accounts = createAccounts(sql, config.free);
  const server = startAdminServer({ sql, oidc, accounts, url: config.url, group: config.group, port: config.port, log: warn });
  printLine(
    `Admin panel on port ${server.port}: ${config.url}, issuer ${config.issuer}, client ${config.clientId}, operator group "${config.group}".`,
  );
  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await server.stop();
  await sql.close();
  return EXIT.ok;
}
