# webdiag-report

The judgment layer of [`webdiag`](../../../README.md) — layer 3 of the
architecture in [`docs/inbox/spec-webdiag.md`](../../../docs/inbox/spec-webdiag.md) §4.

The CLI measures: probes → normalizer → `summary.json`. That part is
deterministic, testable with fixtures and runs in CI without AI. What it cannot
do is decide **how** to run itself for a particular client, or say which of forty
findings is the one costing money. That is what this skill adds.

| | `webdiag` (CLI) | `webdiag-report` (this skill) |
|---|---|---|
| Responsibility | measure | decide and explain |
| Runs without AI | yes | no |
| Usable in CI | yes | no |
| Reads | the live site, the repo | `summary.json`, and nothing else |
| Produces | `raw/`, `findings.json`, `summary.json`, `report.html`, `meta.json` | `narrative.json` → `client-report.html` |

## Install

The skill depends on the CLI; it does not vendor or reimplement it.

```bash
# 1. the measurement half
git clone https://github.com/JoseCortezz25/webdiag.git && cd webdiag
bun install && bun run build && bun link    # puts `webdiag` on PATH

# 2. the judgment half
cp -R .agents/skills/webdiag-report ~/.claude/skills/webdiag-report
```

Working inside this repo, the skill is already reachable: `.claude/skills/` is a
tree of symlinks into `.agents/skills/`, matching the layout the rest of the
skills use.

Requirements: Bun ≥ 1.2 for the CLI, Python 3.9+ for `build_report.py` (standard
library only — no `pip install`).

## Use

Ask for a diagnostic in the conversation and the skill runs the loop: establish
the business context, choose the invocation, read the summary, write the
narrative, build the report. See [`SKILL.md`](SKILL.md) for the full procedure.

The last step is a script, and it is runnable on its own:

```bash
python3 scripts/build_report.py \
  --summary  examples/summary.example.json \
  --narrative examples/narrative.example.json \
  --out /tmp/client-report.html
# build_report: /tmp/client-report.html (4 prioridad(es), formato html)
```

`--format md` renders Markdown instead. Exit codes: `0` rendered, `1` bad
invocation, `3` refused (and it always names the rule).

## What the refusals protect

`build_report.py` is not a template engine with a coat of validation. It is the
mechanical half of the two rules the skill exists to keep:

- **The agent never reads raw probe output.** Pointing `--summary` inside `raw/`
  is refused, and a summary whose schema is not `webdiag.summary/1` is refused
  rather than half-rendered.
- **The narrative prioritises, it does not invent.** A cited finding id that is
  not in the summary is refused; a blocking critical on the summary's cover page
  that no priority mentions is refused. That second one is the whole reason the
  scoring override rule exists — an average would return 71 and bury the
  `noindex` on production.

## Layout

```
webdiag-report/
├── SKILL.md                        the procedure and the judgment guidance
├── README.md                       this file
├── scripts/build_report.py         narrative + summary.json → client report
├── references/
│   ├── narrative-schema.md         the `webdiag.narrative/1` contract
│   └── summary-fields.md           the summary fields the agent reads
└── examples/
    ├── summary.example.json        a real `webdiag scan` output
    └── narrative.example.json      a complete narrative over it
```

`src/scan/skill-contract.test.ts` in the CLI repo guards the shared constants
(schema version, axis list, severity list) against drift between the TypeScript
and the Python.
