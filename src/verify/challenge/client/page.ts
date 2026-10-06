/**
 * Script of the challenge page (spec 006 research R8): checks that cookies work, solves the
 * proof-of-work in a worker and submits the answer. It reads only the page's own form and
 * talks only to the page's own origin.
 */

type WorkerMessage = { type: "progress"; tried: number } | { type: "done"; s: string };

const form = document.getElementById("foxtrust-challenge");
const statusLine = document.getElementById("foxtrust-status");

function show(text: string): void {
  if (statusLine) statusLine.textContent = text;
}

if (form instanceof HTMLFormElement) {
  const { n, d, path } = form.dataset;
  const solution = form.elements.namedItem("s");
  if (!navigator.cookieEnabled) {
    show("Cookies are needed to continue. Allow cookies for this site and reload the page.");
  } else if (n && d && path && solution instanceof HTMLInputElement) {
    const started = Date.now();
    const worker = new Worker(`${path}/worker.js`);
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
      form.submit();
    };
    worker.onerror = () => {
      worker.terminate();
      show("Something went wrong while checking your browser. Reload the page to try again.");
    };
    worker.postMessage({ n, d: Number(d) });
  }
}
