# webdiag

Automated technical diagnostics for websites. One command, deterministic output,
comparable over time.

`webdiag` is the **measurement** half of the system described in
[`docs/inbox/spec-webdiag.md`](docs/inbox/spec-webdiag.md): it runs probes, normalizes
their output against a stable findings catalog, and emits machine-readable JSON plus a
self-contained HTML report. It runs without AI and is usable in CI. Interpreting the
findings for a specific client is the job of a separate Claude skill, not of this CLI.

> **Status: scaffold.** This repository currently ships the project tooling and the
> shape of the CLI. `webdiag --help` works; `webdiag scan` is declared in the interface
> but exits with `2 (not implemented)` until its ticket lands. Nothing here fabricates
> diagnostic results.

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
```

Current output of `webdiag --help`:

```
webdiag 0.1.0 — automated technical diagnostics for websites

USAGE
  webdiag <command> [options]

COMMANDS
  scan  Run a technical diagnostic over a URL and write the report artifacts. (not implemented yet)

OPTIONS
  -h, --help     Show this help and exit
  -v, --version  Show the version and exit

EXAMPLES
  webdiag scan <url> [--repo PATH] [--mode quick|deep] [--axes ...] [--pages N] [--out DIR]
```

### Planned interface

```
webdiag scan <url> [--repo PATH] [--mode quick|deep] [--axes ...] [--pages N] [--out DIR]
```

Writing into `DIR/`: `raw/`, `findings.json`, `summary.json`, `report.html`, `meta.json`.

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | The requested work completed |
| `1`  | Usage error (unknown command, missing argument) |
| `2`  | The command exists in the interface but is not implemented yet |

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
│   └── cli/
│       ├── commands.ts        Declarative registry of the CLI surface
│       ├── exit-codes.ts      Stable exit-code contract
│       ├── help.ts            Renders --help and --version from the registry
│       ├── run.ts             Argv dispatch; returns an exit code, never exits itself
│       └── run.test.ts        Unit tests for dispatch
├── docs/
│   ├── inbox/                 Source material: spec and findings catalog
│   └── agents/                Conventions for agents working in this repo
├── biome.json                 Lint + format configuration
├── tsconfig.json              Strict TypeScript configuration
└── package.json
```

Two design rules the scaffold already enforces:

- **`run.ts` returns an exit code, it does not call `process.exit`.** Only `cli.ts` touches
  the process. That is what makes the whole CLI testable in-process.
- **`--help` is rendered from the command registry.** Help text cannot drift from what is
  actually dispatchable, and `run.test.ts` asserts every registered command appears in it.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull
request: `bun install --frozen-lockfile`, then lint, typecheck, test, build, and a smoke
check of the built binary. Any failure blocks the PR.

## Conventions

Dependency versions are pinned exactly (no `^`), per the reproducibility decision in the
spec: a diagnostic is only comparable across runs if the tool versions are known.

## License

MIT
