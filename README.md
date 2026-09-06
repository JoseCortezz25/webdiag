# webdiag

Automated technical diagnostics for websites. Point it at a URL, get six
scores, a list of findings with evidence, and a self-contained HTML report.

```bash
webdiag scan https://example.com --out ./out
```

What you get in `./out/`:

- **`report.html`** — open it in a browser, share it with a client. No scripts,
  no external requests, works offline.
- **`findings.json`** — every finding with severity, confidence and evidence.
- **`summary.json`** — per-axis scores and the numbers behind them.
- **`meta.json`** — which tools measured what, and when.

## Requirements

- [Bun](https://bun.sh) `>= 1.2` — the `webdiag` binary runs on Bun, so it must
  be installed even when you install via npm.
- Chrome — webdiag downloads its own pinned `chrome-headless-shell` build once,
  on first use, into `~/.cache/puppeteer` (override the location with
  `WEBDIAG_CHROME_CACHE_DIR`, or point at an existing binary with
  `WEBDIAG_CHROME_PATH`). All three browser probes — performance, accessibility
  and dependencies — launch that same binary, so `meta.json` records one
  browser version. Nothing is written to the directory you run the command
  from except the `--out` directory.
- `curl` — needed for the security-headers check. Present by default on macOS
  and most Linux distributions.

No Node.js required.

### Optional tools

Everything optional degrades gracefully: if a tool is missing, the check is
skipped and the report says so. A run never fails because of a missing
optional tool.

| Tool | What it unlocks | How to get it |
|------|-----------------|---------------|
| `testssl.sh` | TLS findings (`SEC-TLS-*`) | `bun run install:testssl`, or put it on `PATH`, or set `WEBDIAG_TESTSSL` |
| `osv-scanner`, Syft | White-box dependency audit (`--repo`) | `bun run install:whitebox` |
| `lychee`, `xmllint` | Link checking and sitemap validation (SEO) | Your system package manager |

## Installation

```bash
npm install -g @ajosecortes/webdiag
webdiag --version
```

Without installing, via `bunx`:

```bash
bunx @ajosecortes/webdiag scan https://example.com --out ./out
```

From source:

```bash
git clone https://github.com/JoseCortezz25/webdiag.git
cd webdiag
bun install
bun run build
bun link   # optional: exposes `webdiag` on your PATH while developing
```

> Containers that cannot create the user namespace Chrome's sandbox needs can
> opt out explicitly with `WEBDIAG_CHROME_NO_SANDBOX=1`.

## Quick start

```bash
# One page, all six axes
webdiag scan https://example.com --out ./out

# Only performance and accessibility, sample up to 5 pages
webdiag scan https://example.com --mode deep --axes PERF,A11Y --pages 5 --out ./out

# Audit your own repo's dependencies against the live site
webdiag scan https://example.com --repo ./my-checkout --axes DEPS --out ./out

# Fail CI when a high-or-worse finding appears
webdiag scan https://example.com --fail-on high --out ./out
```

## What it checks

Six axes, scored independently from 0 to 100. **There is no composite score** —
each axis stands on its own, so a great performance score never hides a
security problem.

| Axis | What it tells you |
|------|-------------------|
| `PERF` | Loading performance (Lighthouse) |
| `A11Y` | Accessibility issues (axe-core), with evidence per element |
| `SEO` | Meta tags, sitemap, robots.txt, broken links |
| `SEC` | Security headers and TLS configuration |
| `DEPS` | JavaScript libraries with known vulnerabilities |
| `AGENT` | How ready the site is for AI agents (`robots.txt`, `llms.txt`, `/.well-known/`) |

### How to read the results

- **Scores:** 0–100 per axis. A `critical` finding marked *blocking* pins its
  axis to 0 — it is not averaged away.
- **Confidence:** findings with `confidence: low` are always listed for
  transparency but never lower your score.
- **Accessibility honesty:** every accessibility run includes
  `A11Y-MANUAL-REVIEW-PENDING`, because ~43% of WCAG criteria need a human and
  no tool covers them. Its evidence lists what could not be checked
  automatically.
- **Determinism:** the same site measured with the same tool versions produces
  byte-identical `findings.json`. Only `meta.json` carries timestamps and
  machine info, so you can diff runs over time.

## Command reference

```
webdiag scan <url> [--repo PATH] [--mode quick|deep] [--axes ...] [--pages N] [--out DIR] [--fail-on SEVERITY]
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--mode` | `quick` | `quick` checks one URL; `deep` follows internal links and samples several pages |
| `--out` | `./webdiag-out` | Where `report.html`, `findings.json`, `summary.json` and `meta.json` are written |
| `--axes` | all six | Comma-separated subset, e.g. `--axes PERF,A11Y,SEO,DEPS,SEC,AGENT` |
| `--pages` | `1` quick / `8` deep | How many pages a `deep` run may sample (5–10); rejected in `quick`, which is always one page |
| `--repo` | none | Path to your repo checkout — enables the white-box dependency audit |
| `--fail-on` | none | Exit `4` if any finding meets this severity or worse (`critical`, `high`, `medium`, `low`, `info`); a `blocking` finding always fails |

Other commands: `webdiag --help`, `webdiag --version`.

### Exit codes

| Code | Meaning | Typical use |
|------|---------|-------------|
| `0` | The scan completed | Read the report in `--out` |
| `1` | Usage error (bad flag, missing URL) | Fix the command |
| `2` | The command exists but is not implemented yet | Check the release notes |
| `3` | The run could not produce artifacts | Check network / target availability |
| `4` | Artifacts produced, but a `--fail-on` budget was exceeded | Gate a deploy or fail CI |
| `5` | Artifacts produced, but at least one requested axis could not be measured | Fix the probe's tooling (Chrome, testssl, network) before trusting the score |

A single probe failing never stops the whole scan: that axis is marked
`failed` in the report and the other five still complete. The exit code is
`5` in that case, so a CI job whose browser never started does not pass
looking identical to a clean site. A `--fail-on` breach (`4`) takes precedence
when both apply.

## Use in CI

Gate a deploy on a severity budget:

```bash
webdiag scan https://staging.example.com --fail-on high --out ./webdiag-out
```

Or use the reusable workflow (scans your repo in white-box mode and uploads
the report as a build artifact):

```yaml
jobs:
  webdiag-budget:
    uses: JoseCortezz25/webdiag/.github/workflows/webdiag.yml@main
    with:
      url: https://example.com
      mode: quick
      axes: DEPS
      fail-on: high
```

| Input | Default | Meaning |
|-------|---------|---------|
| `url` | `https://example.com` | The URL recorded as scan target |
| `mode` | `quick` | `quick` or `deep` |
| `axes` | `DEPS` | Comma-separated subset of axes |
| `fail-on` | `high` | `critical`, `high`, `medium`, `low` or `info`; blocking findings always fail |

## Client reports

`webdiag` measures; turning numbers into a prioritised client narrative is a
separate step handled by the
[`webdiag-report` skill](.agents/skills/webdiag-report). It reads only
`summary.json` and renders a client-facing report:

```bash
python3 .agents/skills/webdiag-report/scripts/build_report.py \
  --summary   ./out/summary.json \
  --narrative ./out/narrative.json \
  --out       ./out/client-report.html
```

## Notes

- The security probe identifies itself as `FlareDiagnostics/1.0 (+<contact>)`,
  honours `robots.txt`, and throttles to one request per second per host. Set
  `WEBDIAG_CONTACT` to change the contact URL an operator sees in their logs.
- Dependency versions are pinned exactly (no `^` ranges) so runs stay
  comparable over time.

## License

MIT
