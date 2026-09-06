# LCP / CLS / TBT / TTFB — calibration decision

**Decision: no threshold was changed.** `THRESHOLDS` in `src/scan/perf/observations.ts`
stays at `lcpMs: 2500`, `cls: 0.1`, `tbtMs: 200`, `ttfbMs: 800`. This document records
the measurements that decision rests on, and the calibration gap those measurements
*did* expose — which is not a threshold.

## Measured values

Captured from the same pinned Lighthouse 13.4.1 configuration the probe uses
(`src/scan/perf/lighthouse.ts`: mobile form factor, simulated throttling, `en-US`),
one run per site:

| Site | Perf category | FCP | LCP | CLS | TBT | TTFB | Speed Index |
|---|---|---|---|---|---|---|---|
| `hipintocol` | 0.54 | 5 457 ms | **20 457 ms** | 0.053 | **295 ms** | 105 ms | 5 773 ms |
| `alfonso` | 0.79 | 1 659 ms | **5 083 ms** | 0.000 | 47 ms | 74 ms | 4 064 ms |
| `thefactsnow` | 0.60 | 5 829 ms | **9 654 ms** | 0.000 | 32 ms | 182 ms | 5 829 ms |

Bold = over the current threshold.

## Why no threshold moved

**1. Every value falls unambiguously on one side of its line.** Not one of the twelve
measurements sits near enough to its threshold for the classification to be arguable:

- LCP 5 083–20 457 ms against a 2 500 ms line — the *smallest* value is 2.0× the
  threshold. All three sites genuinely have poor LCP, and all three fire.
- CLS 0.000–0.053 against a 0.1 line — the largest is barely half the threshold. None
  fire, and none of the three pages visibly shifts.
- TTFB 74–182 ms against an 800 ms line — the largest is under a quarter of it. None
  fire; all three are behind a CDN and respond fast.
- TBT 32–295 ms against a 200 ms line — only the site with the heaviest third-party JS
  (GSAP, Clarity, Webflow runtime) crosses it.

A threshold is miscalibrated when it puts a site on the wrong side. Nothing here does.
Moving any of the four numbers would only change verdicts that are currently correct.

**2. The numbers are the published Core Web Vitals "poor" boundaries, and the probe
measures in exactly the configuration those boundaries are defined for.** Mobile,
simulated throttling. Loosening LCP to, say, 4 000 ms so that fewer sites fail would
produce a number that no longer means what a client reads it to mean, and would
diverge from every other tool the client can check us against.

**3. They are a published contract, not an implementation detail.**
`docs/inbox/findings-catalog.md` §4 states them normatively — "LCP por encima de 2.5s",
"CLS por encima de 0.1", "TTFB por encima de 800ms" — and `src/catalog/entries.ts`
repeats them in each entry's `detects` string. Changing the code without changing the
catalog would desync the two; changing both to chase three samples is not calibration.

## What the measurements did expose

**PERF severity is magnitude-blind.** `PERF-LCP-POOR` deducts a flat 15 points whether
LCP is 2 501 ms or 20 457 ms. That is why `hipintocol` (20.5s) scores 70 and `alfonso`
(5.1s) scores 75: a four-fold difference in the metric a client actually feels
collapses into five points, and `thefactsnow` at 9.7s ties with `alfonso` at 5.1s.
The finding fires correctly on all three; the *score* cannot tell them apart.

The mechanism to fix this already exists and is sanctioned:
`RawObservation.severity` (`src/scan/raw.ts:54`) is documented as an override for
"only when the run justifies deviating from the catalogue base severity", and
`createFinding` honours it (`src/catalog/finding.ts:101`). The open question is what
the escalated severity should be — the only rung above `high` is `critical`, which
under the override rule (`src/catalog/scoring.ts`) zeroes the whole axis. Zeroing PERF
for a 20s LCP may well be the right answer, but it is a scoring-contract decision on
three data points, and it is deliberately **not** taken here. Filed as follow-up.

**TBT sits close enough to its line to flip between runs.** `hipintocol` measured
295 ms in the standalone capture above and did not emit `PERF-TBT-HIGH` in either
full CLI run, meaning it landed at or under 200 ms both times. This is lab variance,
not a threshold error — and it is exactly what the phase-2 catalog ID
`PERF-LAB-VARIANCE-HIGH` exists for. Until that ID is implemented, a TBT verdict near
the threshold should be read as provisional. The `labConfidence` helper already caps
`PERF-TBT-HIGH` at `medium` confidence for a related reason, which limits the damage.

**No field data anywhere.** `PERF-FIELD-UNAVAILABLE` fired on all three sites because
`WEBDIAG_CRUX_API_KEY` is unset, so `labConfidence` never got its field override and
every perf verdict here is lab-only. Calibrating thresholds against field data was
therefore impossible in this run, and any future recalibration should start by setting
that key.
