# Bot-verdict sample recorders (development only)

These scripts record automation samples for the labelled set of the bot verdict (spec 007,
`tests/fixtures/bot-samples/`). They drive real automation tools against `foxtrust bot record`.

- They are **not** part of FoxTrust: nothing in `src/` imports them, the image does not contain them,
  and their packages are not runtime dependencies (constitution Principle VII).
- They never touch real visitors: `bot record` is a separate development server (Principle IV).

```sh
cd tools/bot-samples && bun install
# in another terminal, from the repository root:
bun run foxtrust bot record --label playwright-chromium-headless --kind automation
# then here:
bun run record.ts --tool playwright-chromium
```

Tools: `playwright-chromium`, `playwright-firefox`, `playwright-webkit`, `puppeteer`,
`puppeteer-stealth`, `patchright`. Camoufox: `python camoufox_record.py` (see its header).
Install the browsers once with `bunx playwright install chromium firefox webkit` and
`bunx patchright install chromium`.
