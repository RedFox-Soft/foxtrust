import { loadConfig } from "../../scoring/config";
import { parsePolicy, PolicyError, vocabularyFromConfig } from "../../policy";
import { defaultScoringConfigFile } from "../../verify/config";
import { EXIT, printJson, printLine, rejectUnknown, takeOption, UsageError, warn, type Context } from "../util";

/** `policy check <file> [--scoring-config <file>]`: validates a policy; exit 2 names the offending item. */
export async function policyCheck(args: string[], ctx: Context): Promise<number> {
  const [scoringConfig] = takeOption(args, "--scoring-config");
  rejectUnknown(args);
  const file = args[0];
  if (!file || args.length > 1) throw new UsageError("expected exactly one policy file");
  const configFile = scoringConfig ?? (Bun.env.FOXTRUST_SCORING_CONFIG?.trim() || defaultScoringConfigFile());
  const vocabulary = vocabularyFromConfig(await loadConfig(configFile));
  if (!(await Bun.file(file).exists())) throw new UsageError(`${file} not found`);
  try {
    const policy = parsePolicy(await Bun.file(file).text(), vocabulary);
    if (ctx.json) printJson({ file, valid: true, rules: policy.rules.map((r) => r.name), default: policy.default });
    else printLine(`${file}: valid, ${policy.rules.length} rule(s), default ${policy.default}`);
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    if (ctx.json) printJson({ file, valid: false, problems: error.problems });
    else for (const p of error.problems) warn(`${file}: ${p}`);
    return EXIT.usage;
  }
}
