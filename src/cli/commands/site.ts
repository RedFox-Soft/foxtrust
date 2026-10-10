import { SQL } from "bun";
import { createAccounts } from "../../api/accounts";
import { readSiteConfig, SiteConfigError } from "../../site/config";
import { ContentError, contentValues, loadContent } from "../../site/content";
import { startSiteServer, type SiteSignInDeps } from "../../site/server";
import { createOidc, OidcConfigError } from "../../web/oidc";
import { EXIT, printLine, rejectUnknown, UsageError, warn, type Context } from "../util";

/**
 * `site serve`: the public site (spec 012). Without sign-in settings it serves the public pages only
 * and needs neither the database nor foxauth (research R8). An unreachable foxauth does not stop it:
 * public pages and existing sessions keep working, and sign-in retries.
 */
export async function siteServe(args: string[], _ctx: Context): Promise<number> {
  rejectUnknown(args);
  let config;
  let content;
  try {
    config = readSiteConfig();
    content = await loadContent({ values: contentValues(config) });
  } catch (error) {
    if (error instanceof SiteConfigError || error instanceof ContentError) throw new UsageError(error.message);
    throw error;
  }

  let signIn: SiteSignInDeps | null = null;
  let sql: SQL | null = null;
  if (config.signIn) {
    const s = config.signIn;
    const oidc = createOidc({ issuer: s.issuer, clientId: s.clientId, clientSecret: s.clientSecret, redirectUri: `${config.url}/auth/callback`, scope: "openid profile email" });
    try {
      await oidc.ready();
    } catch (error) {
      if (error instanceof OidcConfigError) throw new UsageError(`FOXTRUST_SITE_ISSUER: ${error.message}`);
      warn(`site: foxauth is not reachable yet (${(error as Error).message}); sign-in retries on each attempt`);
    }
    sql = new SQL(s.databaseUrl, { max: 4 });
    signIn = { sql, oidc, accounts: createAccounts(sql, config.free), issuer: s.issuer, contact: s.contact, maxKeys: config.maxKeys, keysPerDay: config.keysPerDay };
  }

  const server = startSiteServer({ url: config.url, content, signIn, port: config.port, log: warn });
  printLine(
    config.signIn
      ? `Site on port ${server.port}: ${config.url}, sign-in through ${config.signIn.issuer}, client ${config.signIn.clientId}.`
      : `Site on port ${server.port}: ${config.url}, public pages only (no sign-in settings).`,
  );
  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await server.stop();
  await sql?.close();
  return EXIT.ok;
}
