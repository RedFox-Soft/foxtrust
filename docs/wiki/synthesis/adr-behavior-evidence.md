---
type: synthesis
kind: decision
title: "ADR: behavior evidence on the challenge page (press and hold)"
tags: [scoring, first-party]
created: 2026-10-06
updated: 2026-10-06
sources: []
status: accepted
decided: 2026-10-06
---

# ADR: behavior evidence on the challenge page (press and hold)

Decision for backlog item B-12d (spec 009). It extends [[adr-bot-verdict]] with a behavior layer. The research behind it is in [[challenge-bot-detection]].

**Problem**: the environment checks of [[adr-bot-verdict]] catch stock automation, but puppeteer-stealth and Camoufox pass them (SC-003 baseline there). With a token from [[adr-returning-device]], such a browser even skips the proof-of-work on 20 addresses a day. The proof-of-work page finishes in about a second with no input, so it has no behavior to judge.

**Privacy**: constitution v5.1.0 Principle IV. Positions, timings and key events are used in memory for one decision and dropped. The log holds only the outcome, the score and the reason codes. Key values are never collected.

## Decision

| Topic | Choice | Why |
|-------|--------|-----|
| Step | A "Press and hold" button for every challenged visitor while the probe and the proof-of-work run; the answer goes when both are done. `FOXTRUST_BOT_HOLD=off` removes it | Stealth automation scores as low as people, so a score-based trigger would never reach it. The policy already limits who is challenged. |
| Change of spec 006 FR-008 | With the step on, the page needs one action from the visitor. Spec 006 required none | Without input there is no behavior to judge. This is a product decision, not a constitution matter. |
| Completion | The hold completes on **release** after at least 1000 ms; an early release resets it | Completing at 1000 ms would make every person's hold exactly as long as a script's `setTimeout(1000)`. On release, a person lets go a reaction time after the bar fills. |
| Payload | Form field `b`, at most 4096 characters, bound to the challenge nonce: timer resolution, control size, input kind, the last 150 pointer positions as delivered, press, release, moves during the hold, Space/Enter down/up with the repeat flag, the count of untrusted events, visibility and focus changes | Bound and size-limited like the probe of [[adr-bot-verdict]]. A missing, oversized, malformed or foreign payload counts as `behavior.missing`. |
| No downsampling | The client keeps positions as the browser delivers them, then the last 150. Research first proposed one per 16 ms | A scripted burst of moves within a few milliseconds would collapse into one point and hide `behavior.machine_timing`. |
| Keyboard | Judged by key timing: a person's held key makes the operating system send repeated key-downs with the repeat flag; a scripted `keyboard.down` sends one | Keyboard-only and screen-reader users must pass (FR-008 of spec 009). |
| Codes | Eleven `behavior.*` codes in weights `2026-10-06.3` (below). None except untrusted events lifts a clean, low-prior visitor to a step-up on its own | People with unusual input (assistive tools, disabled key repeat, a still finger) are not stopped by one feature. |

### Codes and weights (`2026-10-06.3`)

| Code | Rule (summary) | Weight |
|------|----------------|--------|
| `behavior.missing` | the step is on, but `b` is missing or invalid | +3.0 |
| `behavior.untrusted` | events not produced by a real input device | +5.0 |
| `behavior.teleport` | mouse or pen, fewer than 3 positions in the 600 ms before the press | +2.5 |
| `behavior.straight` | ≥ 10 positions within 1.5 px of the start–press chord | +3.0 |
| `behavior.machine_timing` | pointer moves arrive faster than once per frame (median < 4 ms) | +3.0 |
| `behavior.smooth_curve` | ≥ 15 positions, not straight, at most one change of turn direction | +2.0 |
| `behavior.exact_center` | press within 0.5 px of the control centre | +1.5 |
| `behavior.exact_hold` | release 0–30 ms after the bar fills, with a fine timer | +2.5 |
| `behavior.press_in_motion` | mouse or pen travelled ≥ 10 px in the 100 ms before the press | +2.0 |
| `behavior.no_key_repeat` | key hold ≥ 700 ms without an auto-repeat key-down | +2.5 |
| `behavior.still_touch` | touch hold ≥ 700 ms without any move | +1.0 |

## Measurements (2026-10-06)

Scripted samples, five per label, recorded with `foxtrust bot record --hold` and the tools in `tools/bot-samples/`. The behavior-only verdict (`bpass` in `bot eval`) scores each sample's behavior codes on a clean, low-prior environment: what a stealth browser driving the same input would get.

| Label | Codes | Behavior-only pass |
|-------|-------|--------------------|
| `hold-playwright-straight` | `straight`, `press_in_motion`, `exact_center`, mostly `exact_hold` | 0 / 5 |
| `hold-ghost-cursor` | `press_in_motion`, `exact_hold` | 0 / 5 |
| `hold-stealth-ghost` | `press_in_motion`, `exact_hold`, once `smooth_curve` | 0 / 5 |
| `hold-cdp-direct` | `teleport`, `exact_center`, `exact_hold` | 0 / 5 |
| `hold-key-script` | `exact_hold`, `no_key_repeat` | 0 / 5 |
| `hold-camoufox-humanize` (baseline) | `exact_center`, sometimes `press_in_motion`, once `machine_timing` | 2 / 5 |

- **SC-001** (≥ 95 % of scripted pointer holds get no pass): PASS, 0 of 20.
- **SC-003** (stealth automation with scripted input gets no pass): PASS, `hold-stealth-ghost` 0 of 5 on both verdicts. Weights `.2` passed all five.
- **With a returning-device token** (`--with-device`, −1.0): scripted labels still get no pass; ghost-cursor scores about 0.62.
- **SC-002** (people pass): PASS on the owner's recordings, with no rule loosened:

  | Label | Device | Pass | Behavior codes |
  |-------|--------|------|----------------|
  | `hold-mouse` | desktop mouse | 5 / 5 | none |
  | `hold-touch-phone` | Android phone, Chrome | 15 / 15 | `still_touch` once (+1.0) |
  | `hold-keyboard` | Tab + Space or Enter | 6 / 6 | none; 22–28 auto-repeat key-downs per hold |

  `hold-touchpad` is not recorded yet. People held 1.2–2.2 s; with vibration at completion, phone holds fell to about 1.6 s.

### Calibration

- **Ghost-cursor passed the first rules.** With only the nine pointer codes of the research, ghost-cursor and puppeteer-stealth + ghost-cursor got `exact_hold` alone and passed. Their moves are frame-aligned like a person's, and pixel rounding breaks the single-curvature rule on most of their paths.
- **`press_in_motion` was added.** Every such sample travelled 11–145 px in the last 100 ms and pressed 3–5 ms after its last move, while a person stops on the button before pressing.
- **`exact_hold` was raised to 2.5**, so that a returning-device token does not bring ghost-cursor back to the threshold (it scored exactly 0.50 at 2.0).
- **A low-spread timing rule was dropped.** Research proposed a `dt` coefficient of variation below 0.05 for `machine_timing`. Chrome delivers moves once per frame, so a person's high-rate mouse is as regular as a script; the rule now looks only for moves faster than a frame.

### Found while recording

- **The button jumped.** The status line above it changed length, and the vertically centred card moved with it, so the button slid under a still pointer, which looks like movement. The status now sits below the control and the card is pinned to the top. Five mouse samples taken before the fix were discarded.
- **Android Chrome reported a 0×0 outer window** for a moment after load, which `env.window_zero` read as headless (one phone sample stepped up). The probe now waits up to 1 s for a non-zero outer size; headless Chrome stays at zero. The affected sample was discarded.
- **Vibration at completion.** When the bar fills, the page vibrates for 40 ms where the Vibration API exists (Android), so a finger knows when to let go. iOS has none; the text and the bar remain.
- **DevTools device emulation is not a touch device.** Emulated touches never move and the desktop screen contradicts the phone user agent; such samples were discarded, not labelled human.

## Limits

- **Camoufox `humanize` is a baseline, not a target.** Its cursor model decelerates and varies like a person; only a habit of pressing the exact centre gives it away, and only partly.
- **Rules are hand-made.** A tool that learns them (stop before pressing, release late, aim off-centre) passes. The codes raise the cost; they do not end the race.
- **Assistive input.** Switch devices and eye tracking may produce neither a pointer path nor a key hold; such visitors use the keyboard path, or the operator turns the step off.
- **Small human set.** 26 holds from one person on three kinds of input; the touchpad is still missing. Weights should be re-measured as recordings from other people and devices come in.

## Alternatives rejected

- **A score-based trigger for the step**: stealth automation would never reach it.
- **A learned model on raw trajectories**: it needs much more labelled data, is hard to explain to an operator and needs an ADR of its own.
- **Completing the hold when the bar fills**: every hold would last exactly 1000 ms.
- **Keeping raw events for later training**: Principle IV.
