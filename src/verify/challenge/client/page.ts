import { runHold } from "./hold.ts";
import { runProbe } from "./probe.ts";

/**
 * Script of the challenge page (spec 006 research R8, spec 007 research R1): checks that cookies
 * work, runs the environment probe, solves the proof-of-work in a worker and submits the answer.
 * In recorder mode (`data-record`, `foxtrust bot record`) it only runs the probe and submits.
 * It reads only the page's own form and talks only to the page's own origin.
 */

type WorkerMessage = { type: "progress"; tried: number } | { type: "done"; s: string };

const form = document.getElementById("foxtrust-challenge");
const statusLine = document.getElementById("foxtrust-status");

function show(text: string): void {
  if (statusLine) statusLine.textContent = text;
}

/**
 * A tab that was never shown reports a 0×0 outer window in Chrome, which the probe would read as
 * headless. Wait until the visitor looks at the tab; nothing is lost, nobody is watching it yet.
 */
function whenVisible(): Promise<void> {
  if (document.visibilityState !== "hidden") return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.visibilityState === "hidden") return;
      document.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    document.addEventListener("visibilitychange", onChange);
  });
}

/**
 * `foxtrust bot record` only (spec 007 SC-004, spec 006 SC-001): reports how long the probe took and
 * how long the proof-of-work at the recorder's difficulty takes on this device. Never on the real page.
 */
async function measureForRecorder(form: HTMLFormElement, probeMs: number): Promise<void> {
  const set = (name: string, value: string) => {
    const field = form.elements.namedItem(name);
    if (field instanceof HTMLInputElement) field.value = value;
  };
  set("tp", probeMs.toFixed(1));
  const { powN, powD } = form.dataset;
  if (!powN || !powD) return;
  show("Measuring the proof-of-work on this device…");
  const started = performance.now();
  const worker = new Worker("/worker.js");
  await new Promise<void>((resolve) => {
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (event.data.type === "done") resolve();
    };
    worker.onerror = () => resolve();
    worker.postMessage({ n: powN, d: Number(powD) });
  });
  worker.terminate();
  set("tw", (performance.now() - started).toFixed(0));
}

async function start(form: HTMLFormElement): Promise<void> {
  const { n, d, path, record, hold } = form.dataset;
  const solution = form.elements.namedItem("s");
  const probeField = form.elements.namedItem("p");
  const behaviorField = form.elements.namedItem("b");
  if (!navigator.cookieEnabled && record === undefined) {
    show("Cookies are needed to continue. Allow cookies for this site and reload the page.");
    return;
  }
  if (!n || !(probeField instanceof HTMLInputElement)) return;
  await whenVisible();

  /** The press-and-hold step (spec 009), when the page has one. */
  const holdStep = (): Promise<void> | null => {
    const button = document.getElementById("foxtrust-hold");
    const progress = document.getElementById("foxtrust-hold-progress");
    if (hold === undefined || !(button instanceof HTMLButtonElement) || !(progress instanceof HTMLProgressElement)) return null;
    if (!(behaviorField instanceof HTMLInputElement)) return null;
    return runHold({ button, progress, show }).then((payload) => {
      behaviorField.value = JSON.stringify({ ...payload, n });
    });
  };

  if (record !== undefined) {
    const probeStarted = performance.now();
    probeField.value = JSON.stringify(await runProbe(n));
    const held = holdStep();
    if (held) await held;
    else await measureForRecorder(form, performance.now() - probeStarted);
    form.submit();
    return;
  }
  if (!d || !path || !(solution instanceof HTMLInputElement)) return;

  // Probe, proof-of-work and hold run side by side; the answer goes when all are done (spec 007, 009).
  const started = Date.now();
  const worker = new Worker(`${path}/worker.js`);
  const probed = runProbe(n).then((result) => {
    probeField.value = JSON.stringify(result);
  });
  const held = holdStep();
  const solved = new Promise<void>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === "progress") {
        const seconds = Math.floor((Date.now() - started) / 1000);
        if (seconds >= 3 && !held) show(`Still checking your browser (${seconds} s)…`);
        return;
      }
      worker.terminate();
      solution.value = message.s;
      resolve();
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error("worker"));
    };
  });
  worker.postMessage({ n, d: Number(d) });
  await Promise.all([solved, probed, held ?? Promise.resolve()]);
  show("Done. Taking you back…");
  form.submit();
}

if (form instanceof HTMLFormElement) {
  start(form).catch(() => show("Something went wrong while checking your browser. Reload the page to try again."));
}
