import { join } from "node:path";

/**
 * The two browser scripts of the challenge page, bundled in memory at start with Bun's own
 * bundler (spec 006 research R8): no build step and no extra dependency.
 */

export type ChallengeAssets = { "page.js": string; "worker.js": string };

const CLIENT_DIR = join(import.meta.dir, "client");
let built: Promise<ChallengeAssets> | null = null;

async function build(): Promise<ChallengeAssets> {
  const result = await Bun.build({
    entrypoints: [join(CLIENT_DIR, "page.ts"), join(CLIENT_DIR, "worker.ts")],
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
  });
  if (!result.success) throw new Error(`challenge page scripts did not build:\n${result.logs.map(String).join("\n")}`);
  const out: Partial<ChallengeAssets> = {};
  for (const artifact of result.outputs) {
    const name = artifact.path.split(/[\\/]/).pop();
    if (name === "page.js" || name === "worker.js") out[name] = await artifact.text();
  }
  if (!out["page.js"] || !out["worker.js"]) throw new Error("challenge page scripts: build output is missing page.js or worker.js");
  return out as ChallengeAssets;
}

/** Builds once per process; later calls share the result. */
export function buildChallengeAssets(): Promise<ChallengeAssets> {
  built ??= build().catch((error: unknown) => {
    built = null;
    throw error;
  });
  return built;
}
