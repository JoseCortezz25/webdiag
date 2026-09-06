# webdiag

Automated technical diagnostics for websites. One command, deterministic output,
comparable over time.

`webdiag` is the **measurement** half of the system described in
[`docs/inbox/spec-webdiag.md`](docs/inbox/spec-webdiag.md): it runs probes, normalizes
their output against a stable findings catalog, and emits machine-readable JSON plus a
self-contained HTML report. It runs without AI and is usable in CI. Interpreting the
findings for a specific client is the job of a separate Claude skill, not of this CLI.

> **Status: phase 0 — skeleton with fixture data.** The whole pipeline runs end to end
> (orchestrator → probe → normalizer → report), but the only probe that exists is a stub
> that returns fixed data. `webdiag scan` writes every artifact of the real contract and
> the numbers in them are **invented**. Real probes land in phase 1; until then the report
> is for validating the flow and the design, not for sending to a client.

## Requirements

- [Bun](https://bun.sh) `>= 1.2` (developed against 1.3.11)

No Node.js or npm required.

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

## The agent layer

`webdiag` deliberately stops at measurement. Deciding *how* to invoke it for a given
client, and deciding which of forty findings is the one costing money, is judgment that
lives in a Claude skill: [`.agents/skills/webdiag-report`](.agents/skills/webdiag-report)
(spec §4, layer 3).

| | `webdiag` (CLI) | `webdiag-report` (skill) |
|---|---|---|
| Responsibility | measure | decide and explain |
| Runs without AI | yes | no |
| Usable in CI | yes | no |
| Reads | the live site, the repo | `summary.json`, and nothing else |
| Produces | `raw/`, `findings.json`, `summary.json`, `report.html`, `meta.json` | `narrative.json` → `client-report.html` |

The skill installs this CLI as a dependency, calls `webdiag scan` with a mode, axis set
and page count chosen from the conversation, writes a prioritised narrative, and renders
the client report with `build_report.py`:

```bash
python3 .agents/skills/webdiag-report/scripts/build_report.py \
  --summary   ./out/summary.json \
  --narrative ./out/narrative.json \
  --out       ./out/client-report.html
```

The script refuses (exit `3`) if the narrative cites a finding the summary does not
contain, or if a blocking critical from the summary's cover page is left unranked.
`src/scan/skill-contract.test.ts` guards the constants the Python restates — schema
version, axes, severities — against drift from the TypeScript.

## Repository structure

```
.
├── .github/workflows/ci.yml   CI: lint · typecheck · test · build on every push and PR
├── .agents/skills/            Agent skills; .claude/skills/ symlinks into this tree
│   └── webdiag-report/        Layer 3: the judgment and drafting skill
│       ├── SKILL.md           The procedure: context → invocation → narrative → report
│       ├── scripts/           `build_report.py`, narrative + summary → client report
│       ├── references/        The narrative contract and the summary fields it reads
│       └── examples/          A real summary plus a complete narrative over it
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
│       ├── stub-probe.ts      Phase 0 probe: fixed data, no network, no external tool
│       ├── raw.ts             `webdiag.raw/1`, the intermediate format probes emit
│       ├── normalize.ts       Raw → findings: catalog admission, merge, stable order
│       ├── summary.ts         Builds `summary.json`, the agent layer's only input
│       ├── meta.ts            Builds `meta.json`: catalog and tool versions
│       ├── report.ts          Renders the self-contained `report.html`
│       ├── orchestrator.ts    Wires it together and writes the artifacts
│       └── skill-contract.test.ts  Guards the skill's copies of schema, axes, severities
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
- **The agent layer cannot reach the raw dumps.** `summary.json` carries every number,
  path, remediation and piece of evidence a client report needs, and `build_report.py`
  refuses a `--summary` that points inside `raw/`.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull
request: `bun install --frozen-lockfile`, then lint, typecheck, test, build, and a smoke
check of the built binary. Any failure blocks the PR.

## Conventions

Dependency versions are pinned exactly (no `^`), per the reproducibility decision in the
spec: a diagnostic is only comparable across runs if the tool versions are known.

## License

MIT
