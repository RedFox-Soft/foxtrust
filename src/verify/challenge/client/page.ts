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
  const { n, d, path, record } = form.dataset;
  const solution = form.elements.namedItem("s");
  const probeField = form.elements.namedItem("p");
  if (!navigator.cookieEnabled && record === undefined) {
    show("Cookies are needed to continue. Allow cookies for this site and reload the page.");
    return;
  }
  if (!n || !(probeField instanceof HTMLInputElement)) return;
  await whenVisible();
  if (record !== undefined) {
    const probeStarted = performance.now();
    probeField.value = JSON.stringify(await runProbe(n));
    await measureForRecorder(form, performance.now() - probeStarted);
    form.submit();
    return;
  }
  if (!d || !path || !(solution instanceof HTMLInputElement)) return;

  // The probe runs while the worker solves, so it adds nothing to the visitor's wait (spec 007 SC-004).
  const started = Date.now();
  const worker = new Worker(`${path}/worker.js`);
  const probed = runProbe(n).then((result) => {
    probeField.value = JSON.stringify(result);
  });
  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;
    if (message.type === "progress") {
      const seconds = Math.floor((Date.now() - started) / 1000);
      if (seconds >= 3) show(`Still checking your browser (${seconds} s)…`);
      return;
    }
    worker.terminate();
    solution.value = message.s;
    show("Done. Taking you back…");
    void probed.finally(() => form.submit());
  };
  worker.onerror = () => {
    worker.terminate();
    show("Something went wrong while checking your browser. Reload the page to try again.");
  };
  worker.postMessage({ n, d: Number(d) });
}

if (form instanceof HTMLFormElement) {
  start(form).catch(() => show("Something went wrong while checking your browser. Reload the page to try again."));
}
