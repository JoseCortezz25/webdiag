# webdiag

Automated technical diagnostics for websites. One command, deterministic output,
comparable over time.

`webdiag` is the **measurement** half of the system described in
[`docs/inbox/spec-webdiag.md`](docs/inbox/spec-webdiag.md): it runs probes, normalizes
their output against a stable findings catalog, and emits machine-readable JSON plus a
self-contained HTML report. It runs without AI and is usable in CI. Interpreting the
findings for a specific client is the job of a separate Claude skill, not of this CLI.

> **Status: phase 1 — the first real probe.** Accessibility is measured for real:
> `A11Y` runs [axe-core](https://github.com/dequelabs/axe-core) against the page as
> Chrome renders it. The other five axes are still backed by the phase 0 fixture and
> their numbers are **invented**. `meta.json` names the tool per axis, so a fixture is
> never mistaken for a measurement: look for `webdiag-stub` there before quoting a
> number to anyone.

## Requirements

- [Bun](https://bun.sh) `>= 1.2` (developed against 1.3.11)
- Chrome, downloaded automatically by `bun install` (Puppeteer's own build). The
  accessibility probe needs a real rendering engine; nothing else does yet.

No Node.js or npm required.

Chrome's sandbox is left on, because the probe renders untrusted third-party pages.
Containers that cannot create the user namespace it needs can opt out explicitly with
`WEBDIAG_CHROME_NO_SANDBOX=1`.

## Installation

```bash
git clone https://github.com/JoseCortezz25/webdiag.git
cd webdiag
bun install
bun run build
```

To expose the `webdiag` command on your `PATH` while developing:

```bash
bun link          # registers this checkout globally
webdiag --help
bun unlink        # undo it
```

## Usage

```bash
webdiag --help       # show the CLI interface
webdiag --version    # print the version

webdiag scan https://example.com --mode quick --out ./out
```

Current output of `webdiag --help`:

```
webdiag 0.1.0 — automated technical diagnostics for websites

USAGE
  webdiag <command> [options]

COMMANDS
  scan  Run a technical diagnostic over a URL and write the report artifacts.

OPTIONS
  -h, --help     Show this help and exit
  -v, --version  Show the version and exit

EXAMPLES
  webdiag scan <url> [--repo PATH] [--mode quick|deep] [--axes ...] [--pages N] [--out DIR]
```

### `webdiag scan`

```
webdiag scan <url> [--repo PATH] [--mode quick|deep] [--axes ...] [--pages N] [--out DIR]
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--mode` | `quick` | `quick` is one URL with no crawl; `deep` samples several pages |
| `--out` | `./webdiag-out` | Where the artifacts are written |
| `--axes` | all six | Comma-separated subset of `PERF,A11Y,SEO,DEPS,SEC,AGENT` |
| `--pages` | `1` quick / `5` deep | Pages a deep run may sample |
| `--repo` | none | Path to the checkout, for white-box checks |

Writing into `DIR/`:

| Artifact | What it is |
|----------|------------|
| `raw/<AXIS>.json` | What each probe produced, before any interpretation |
| `findings.json` | Catalog IDs with severity, confidence, count and evidence. Deterministic: same input, same bytes |
| `summary.json` | Per-axis scores and the arithmetic behind them. The **only** file the agent layer reads |
| `report.html` | Self-contained client report. No scripts, no external requests |
| `meta.json` | Catalog version, every tool version, runtime and timings |

**There is no composite score.** Each of the six axes is scored independently on 0–100,
and a `critical` finding marked *blocking* fixes its own axis at 0 instead of being
averaged away (spec §5.1 and §6). Findings with `confidence: low` are always listed and
never deducted.

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | The requested work completed |
| `1`  | Usage error (unknown command, missing argument) |
| `2`  | The command exists in the interface but is not implemented yet |
| `3`  | The invocation was valid but the run could not produce its artifacts |

## Scripts

| Script | What it does |
|--------|--------------|
| `bun run dev` | Run the CLI straight from TypeScript source |
| `bun run build` | Bundle `src/cli.ts` into an executable `dist/cli.js` |
| `bun run typecheck` | `tsc --noEmit` in strict mode |
| `bun run lint` | Biome lint **and** format check (read-only) |
| `bun run lint:fix` | Biome lint with safe fixes applied |
| `bun run format` | Rewrite files with the Biome formatter |
| `bun run format:check` | Formatting check only, no writes |
| `bun test` | Bun's test runner |

## Repository structure

```
.
├── .github/workflows/ci.yml   CI: lint · typecheck · test · build on every push and PR
├── src/
│   ├── cli.ts                 Executable entrypoint (shebang, argv, exit code)
│   ├── cli.test.ts            Integration test: spawns the real CLI process
│   ├── version.ts             VERSION and PROGRAM_NAME constants
│   ├── version.test.ts        Guards VERSION against drifting from package.json
│   ├── cli/
│   │   ├── commands.ts        Declarative registry of the CLI surface
│   │   ├── exit-codes.ts      Stable exit-code contract
│   │   ├── help.ts            Renders --help and --version from the registry
│   │   ├── run.ts             Argv dispatch; returns an exit code, never exits itself
│   │   └── scan-command.ts    Adapter: argv in, exit code and console lines out
│   ├── catalog/               The findings catalog: the contract between the layers
│   │   ├── entries.ts         The 82 published IDs, transcribed from the normative doc
│   │   ├── finding.ts         Runtime schema for one finding occurrence
│   │   ├── scoring.ts         Per-axis scoring and the blocking override rule
│   │   └── contract-lock.ts   Frozen fingerprints: an ID cannot be redefined in place
│   └── scan/                  The pipeline
│       ├── args.ts            Parses `scan` flags into a request
│       ├── probe.ts           Probe contract; a probe failure never ends the run
│       ├── probes.ts          Which probe runs for which axis: real, or still fixture
│       ├── stub-probe.ts      Phase 0 probe: fixed data, no network, no external tool
│       ├── a11y/              The accessibility probe (axe-core in headless Chrome)
│       │   ├── axe.ts             The axe payload, validated at the browser boundary
│       │   ├── mapping.ts         axe rule IDs → catalog IDs, as data
│       │   ├── adapter.ts         axe report → raw observations; pure, no browser
│       │   ├── browser-runner.ts  The only part that launches Chrome
│       │   └── probe.ts           Wiring, and the tool identity written to meta.json
│       ├── raw.ts             `webdiag.raw/1`, the intermediate format probes emit
│       ├── normalize.ts       Raw → findings: catalog admission, merge, stable order
│       ├── summary.ts         Builds `summary.json`, the agent layer's only input
│       ├── meta.ts            Builds `meta.json`: catalog and tool versions
│       ├── report.ts          Renders the self-contained `report.html`
│       └── orchestrator.ts    Wires it together and writes the artifacts
├── docs/
│   ├── inbox/                 Source material: spec and findings catalog
│   └── agents/                Conventions for agents working in this repo
├── biome.json                 Lint + format configuration
├── tsconfig.json              Strict TypeScript configuration
└── package.json
```

Design rules the code enforces rather than documents:

- **`run.ts` returns an exit code, it does not call `process.exit`.** Only `cli.ts` touches
  the process. That is what makes the whole CLI testable in-process.
- **`--help` is rendered from the command registry.** Help text cannot drift from what is
  actually dispatchable, and `run.test.ts` asserts every registered command appears in it.
- **Nothing time-dependent reaches `findings.json`.** The clock and the machine are
  confined to `meta.json`, so two runs over the same data produce identical bytes.
- **No probe failure ends a run.** A probe that throws is recorded as `failed` for its
  axis; the other five axes still produce a report.
- **A clean automated pass is never reported as a clean site.** Every accessibility run
  emits `A11Y-MANUAL-REVIEW-PENDING`, because roughly 43% of WCAG criteria need human
  judgement and no tool covers them. Its evidence lists what axe could not settle.
- **The probe never decides severity.** Observations carry no severity, so the catalog
  stays the only authority: `A11Y-FORM-LABEL-MISSING` is `high`, and
  `A11Y-BUTTON-NAME-MISSING` is a blocking `critical` that zeroes the axis.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull
request: `bun install --frozen-lockfile`, then lint, typecheck, test, build, and a smoke
check of the built binary. Any failure blocks the PR.

## Conventions

Dependency versions are pinned exactly (no `^`), per the reproducibility decision in the
spec: a diagnostic is only comparable across runs if the tool versions are known.

## License

MIT
