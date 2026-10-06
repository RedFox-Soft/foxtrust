import type { BotDeps } from "../challenge/routes";
import type { VerifyConfig } from "../config";
import { JA4_FAMILIES_FILE, loadJa4Families } from "./ja4";
import { activeWeightsFile, loadWeights } from "./weights";
import { loadZones } from "./zones";

/**
 * Loads what the bot verdict needs at start (spec 007): the weights, the zone table and the JA4
 * family list. Null when the verdict is off. Errors name the file, so `verify serve` can refuse to start.
 */
export async function loadBotDeps(settings: VerifyConfig["bot"]): Promise<BotDeps | null> {
  if (settings.mode === "off") return null;
  const { weightsFile, ja4FamiliesFile, ...policy } = settings;
  return {
    policy,
    weights: await loadWeights(weightsFile ?? activeWeightsFile({})),
    zones: await loadZones(),
    families: await loadJa4Families(ja4FamiliesFile ?? JA4_FAMILIES_FILE),
  };
}
