# Phase 1 validation — three real sites

Issue [#8](https://github.com/JoseCortezz25/webdiag/issues/8). Run date **2026-09-06**,
catalog `1.0.0`, `webdiag@0.1.0`, `--mode quick` (one URL, no crawl).

This directory is the calibration record for phase 1: what the six probes actually
reported against three production sites, whether each axis score matches the severity
a human sees on the page, and which findings should not be trusted yet.

| File | Contents |
|---|---|
| `results.md` | Per-axis scores and findings for each site, plus the axis-by-axis contrast against expected severity |
| `thresholds.md` | The LCP / CLS / TBT / TTFB calibration decision and the measurements behind it |
| `doubtful-findings.md` | False positives, mislabelled findings and over-severe findings, each with reproduction evidence |

## How the run was produced

```
bun install
bun run install:testssl          # SEC needs testssl.sh 3.2.1 for the TLS checks
bun run ./src/cli.ts scan <url> --mode quick --out /tmp/out-8-<slug>
```

Artifacts (`raw/*.json`, `findings.json`, `summary.json`, `meta.json`, `report.html`)
were written to `/tmp/out-8-{hipintocol,alfonso,thefactsnow}` and are not committed:
they carry full response bodies and selectors from third-party sites. The numbers
quoted in these documents are transcribed from those `summary.json` files.

## Targets

| Slug | URL | Stack | Expected posture |
|---|---|---|---|
| `hipintocol` | https://www.hipintocol.co/ | Webflow marketing site | worst |
| `alfonso` | https://alfonso-portafolio.vercel.app/ | Next.js on Vercel | healthiest |
| `thefactsnow` | https://www.thefactsnow.com/ | WordPress behind Cloudflare | middle |

The "expected posture" column is a prior, not a verdict. It is what the three sites
look like to a human before the tool runs; the point of the exercise is to check
whether each axis independently reproduces that ordering, and where it does not.
