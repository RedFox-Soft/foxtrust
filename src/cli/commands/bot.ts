import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Elysia } from "elysia";
import { evaluateSamples, type EvalResult } from "../../bot/eval";
import { DEFAULT_DIFFICULTY, readBotSettings } from "../../verify/config";
import { activeWeightsFile } from "../../verify/bot/weights";
import { parseProbe } from "../../verify/bot/probe-schema";
import { buildChallengeAssets } from "../../verify/challenge/assets";
import { COMMON_HEADERS, pageHeaders, renderRecorded, renderRecorderPage } from "../../verify/challenge/page";
import { printJson, printLine, printTable, rejectUnknown, takeFlag, takeOption, UsageError, type Context } from "../util";

/**
 * `foxtrust bot record` (spec 007 contracts/bot-verdict.md): a development server that records
 * labelled samples of the environment probe from the developer's own browsers and tools. It is never
 * part of `verify serve`, so real visitors are never recorded (constitution Principle IV).
 */

const SAMPLES_DIR = join(import.meta.dir, "..", "..", "..", "tests", "fixtures", "bot-samples");
const HEADERS = ["user-agent", "accept-language", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "x-ja4"] as const;
const MAX_BODY = 8192;
/** Difficulty the recorder times on the device: the default for medium-level addresses (spec 006). */
const POW_BITS = DEFAULT_DIFFICULTY.medium;

const one = (args: string[], name: string) => takeOption(args, name).at(-1);

/** The product and version a user agent names, for samples recorded without --tool/--version. */
function productOf(userAgent: string): { tool: string; version: string } {
  for (const [tool, pattern] of [
    ["edge", /\bEdg\/([\d.]+)/], ["tor-or-firefox", /\bFirefox\/([\d.]+)/], ["headless-chrome", /\bHeadlessChrome\/([\d.]+)/],
    ["chrome", /\b(?:Chrome|CriOS)\/([\d.]+)/], ["safari", /\bVersion\/([\d.]+).*Safari\//],
  ] as const) {
    const match = pattern.exec(userAgent);
    if (match) return { tool, version: match[1]! };
  }
  return { tool: "unknown", version: "unknown" };
}

export async function botRecord(args: string[], _ctx: Context): Promise<number> {
  const label = one(args, "--label");
  const kind = one(args, "--kind") ?? "human";
  const addressKind = one(args, "--address-kind") ?? "residential";
  const port = Number(one(args, "--port") ?? "8795");
  const listen = one(args, "--listen") ?? "127.0.0.1";
  const out = one(args, "--out") ?? SAMPLES_DIR;
  const toolOverride = one(args, "--tool");
  const versionOverride = one(args, "--version");
  rejectUnknown(args);
  if (!label || !/^[a-z0-9-]{2,64}$/.test(label)) throw new UsageError("--label is required: 2–64 lower-case letters, digits or dashes");
  if (kind !== "human" && kind !== "automation") throw new UsageError("--kind must be human or automation");
  if (!["residential", "tor", "cloud"].includes(addressKind)) throw new UsageError("--address-kind must be residential, tor or cloud");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError("--port must be a port number");

  const assets = await buildChallengeAssets();
  const script = (body: string) => () => new Response(body, { headers: { ...COMMON_HEADERS, "Content-Type": "text/javascript; charset=utf-8" } });
  await mkdir(join(out, label), { recursive: true });

  const app = new Elysia()
    .get("/", () => {
      // A fresh nonce per page load: the device solves one medium-difficulty proof-of-work for timing.
      const powNonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
      return new Response(renderRecorderPage({ label, powNonce, powBits: POW_BITS }), { headers: pageHeaders() });
    })
    .get("/page.js", script(assets["page.js"]))
    .get("/worker.js", script(assets["worker.js"]))
    .post(
      "/record",
      async ({ request }) => {
        const body = await request.text();
        if (body.length > MAX_BODY) return new Response("too large\n", { status: 400 });
        const form = new URLSearchParams(body);
        const probe = parseProbe(form.get("p"), "*");
        const ms = (name: string) => {
          const value = Number(form.get(name));
          return Number.isFinite(value) && value > 0 && value < 600_000 ? value : null;
        };
        const timing = { probeMs: ms("tp"), powMs: ms("tw"), powBits: POW_BITS };
        if (!probe) return new Response("the probe result is invalid\n", { status: 400 });
        const headers: Record<string, string> = {};
        for (const name of HEADERS) {
          const value = request.headers.get(name);
          if (value !== null) headers[name] = value;
        }
        const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
        const product = productOf(headers["user-agent"] ?? "");
        const recordedAt = new Date().toISOString();
        const sample = {
          label, kind, tool: toolOverride ?? product.tool, version: versionOverride ?? product.version, recordedAt, addressKind,
          headers: { ...headers, proto }, probe, timing,
        };
        const file = join(out, label, `${label}-${recordedAt.replace(/[:.]/g, "-")}.json`);
        await Bun.write(file, `${JSON.stringify(sample, null, 2)}\n`);
        printLine(`recorded ${file} (probe ${timing.probeMs ?? "?"} ms, proof-of-work ${timing.powBits} bits ${timing.powMs ?? "?"} ms)`);
        return new Response(renderRecorded({ file: `${label}/${file.split(/[\\/]/).pop()}` }), { headers: pageHeaders() });
      },
      { parse: "none" },
    )
    .listen({ port, hostname: listen });

  printLine(`Recording "${label}" (${kind}, ${addressKind}) at http://${listen}:${app.server!.port}/ — open it in the browser; Ctrl+C to stop.`);
  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await app.stop();
  return 0;
}

const percent = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)} %`);
const check = (value: boolean | null) => (value === null ? "n/a (no samples)" : value ? "PASS" : "FAIL");

/** `foxtrust bot eval` (spec 007 contracts): weights measured on the labelled set; a measurement, not a test. */
export async function botEval(args: string[], ctx: Context): Promise<number> {
  const samplesDir = one(args, "--samples") ?? SAMPLES_DIR;
  const weightsArg = one(args, "--weights");
  const compareFile = one(args, "--compare");
  const withDevice = takeFlag(args, "--with-device");
  rejectUnknown(args);
  const problems: string[] = [];
  const settings = readBotSettings((name) => Bun.env[name]?.trim() || null, problems);
  if (problems.length > 0) throw new UsageError(problems.join("\n"));
  const { weightsFile, ja4FamiliesFile, ...policy } = settings;
  const { result, compare } = await evaluateSamples({
    samplesDir, weightsFile: weightsArg ?? weightsFile ?? activeWeightsFile(), compareFile, policy, ja4FamiliesFile, withDevice,
  });
  if (ctx.json) {
    printJson({ result, compare });
    return 0;
  }
  const other = new Map((compare?.labels ?? []).map((l) => [l.label, l]));
  printLine(
    `Weights ${result.weightsVersion}${compare ? ` vs ${compare.weightsVersion}` : ""}; step-up ${policy.stepUp}, block ${policy.block}; ` +
      `first attempt${withDevice ? "; every sample presents a returning-device token" : ""}.`,
  );
  printTable(
    ["label", "kind", "n", "pass", "stepup", "block", "mean", ...(compare ? [`pass@${compare.weightsVersion}`, "Δpass"] : [])],
    result.labels.map((l) => {
      const c = other.get(l.label);
      return [l.label, l.kind, l.samples, l.pass, l.stepup, l.block, l.meanScore, ...(compare ? [c?.pass ?? "-", c ? c.pass - l.pass : "-"] : [])];
    }),
  );
  const summary = (r: EvalResult, name: string) => {
    printLine(`${name}: human false positives ${percent(r.humanFalsePositiveRate)} (Tor Browser ${percent(r.torFalsePositiveRate)}); ` +
      `SC-001 ${check(r.sc001)}; SC-002 ${check(r.sc002)}`);
  };
  summary(result, result.weightsVersion);
  if (compare) summary(compare, compare.weightsVersion);
  return 0;
}
