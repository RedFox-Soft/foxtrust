import { loadConfig } from "../../scoring/config";
import { vocabularyFromConfig } from "../../policy";
import { importTrustedKeys } from "../../snapshot/sign";
import { readVerifyConfig, VerifyConfigError } from "../../verify/config";
import { createLoader } from "../../verify/loader";
import { createPolicyHolder } from "../../verify/policy-file";
import { startVerifyServer } from "../../verify/server";
import { EXIT, printLine, rejectUnknown, UsageError, warn, type Context } from "../util";

/** `verify serve`: the forward-auth service, configured from the environment (contracts/verify-http.md). */
export async function verifyServe(args: string[], _ctx: Context): Promise<number> {
  rejectUnknown(args);
  let config;
  let trustedKeys;
  try {
    config = readVerifyConfig();
    trustedKeys = await importTrustedKeys(config.trustedKeys);
  } catch (error) {
    if (error instanceof VerifyConfigError) throw new UsageError(error.message);
    throw new UsageError(`FOXTRUST_TRUSTED_KEYS: ${(error as Error).message}`);
  }

  const vocabulary = vocabularyFromConfig(await loadConfig(config.scoringConfigFile));
  const policy = createPolicyHolder(config.policyFile, vocabulary, warn);
  if (!(await policy.load())) throw new UsageError(`${config.policyFile}: ${policy.status().lastError}`);
  const stopWatch = policy.watch();

  const loader = createLoader({ publicationUrl: config.publicationUrl, trustedKeys, maxAgeHours: config.maxAgeHours });
  const stopUpdates = loader.start(config.updateEvery);
  const server = startVerifyServer({ loader, policy, config, port: config.port, log: warn });
  printLine(
    `/verify on port ${server.port}: publication ${config.publicationUrl}, ${trustedKeys.length} trusted key(s) ` +
      `(${trustedKeys.map((k) => k.keyId).join(", ")}), fail mode ${config.failMode}, updates "${config.updateEvery}".`,
  );
  if (!config.challengeUrl) warn(`FOXTRUST_CHALLENGE_URL is not set: challenge decisions fall back to ${config.challengeFallback}.`);

  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  stopUpdates();
  stopWatch();
  await server.stop();
  return EXIT.ok;
}
