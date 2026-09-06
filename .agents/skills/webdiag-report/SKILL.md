---
name: webdiag-report
description: Run a webdiag technical diagnostic and turn it into a prioritised client report. Use when the user asks to diagnose, audit, or report on a website's performance, accessibility, SEO, security, dependencies or agent-readiness, or mentions webdiag, summary.json, or a client-facing technical report.
---

# webdiag-report

`webdiag` measures. You judge.

The CLI already produces a deterministic, complete artifact set. Re-describing it
is not a report: the client does not need six scores, they need to know **what to
fix first and why it costs them money**. That judgment is the only thing this
layer adds, and it is the only thing that cannot be computed.

Three rules, in order of how badly breaking them hurts:

1. **Read `summary.json` and nothing else.** `raw/*.json` is a Lighthouse dump
   and an axe dump. Opening one burns the context you need for judgment and buys
   nothing: every number, path, remediation and piece of evidence that belongs in
   a report is already in the summary. `findings.json` and `meta.json` are also
   out of scope — the summary carries what you need from both.
2. **Decide the invocation from the conversation, not from a default.** Mode,
   axes and page count depend on what the client sells, who visits, and what
   they asked. That context exists only in the conversation. See
   [Choosing the invocation](#choosing-the-invocation).
3. **Never invent a finding, never bury a blocking one.** `build_report.py`
   enforces both and will refuse to render. See [Guardrails](#guardrails).

## Prerequisite: the CLI

The skill installs `webdiag` as a dependency; it does not reimplement it.

```bash
webdiag --version      # already installed?
```

If it is missing, install from the repo (Bun >= 1.2 required):

```bash
git clone https://github.com/JoseCortezz25/webdiag.git && cd webdiag
bun install && bun run build && bun link
```

`bun link` puts `webdiag` on `PATH`. Inside a checkout, `bun run ./src/cli.ts …`
works without linking.

## Workflow

### 1. Establish the business context

Before running anything, you need enough to prioritise. If the conversation does
not already answer these, ask — one question at a time, and stop at the first
answer that unblocks the run:

- What does the site do commercially? (sells, captures leads, informs, serves a
  logged-in product)
- Who is the audience, and what is the device/connection profile?
- Is there a trigger? (a redesign, a traffic drop, a legal/accessibility
  requirement, a migration, a client complaint)
- Is there a deadline or a fixed budget for fixes?

Two identical summaries produce two different reports when the businesses
differ. A 2.8 s LCP is a footnote for an internal admin tool and a revenue
emergency for a mobile-first checkout. If you cannot say which one you are
looking at, you cannot rank anything.

### 2. Choose the invocation

```
webdiag scan <url> [--repo PATH] [--mode quick|deep] [--axes ...] [--pages N] [--out DIR]
```

| Decision | Choose | When |
|---|---|---|
| `--mode quick` | one URL, no crawl (default, `--pages` 1) | first look, single landing page, a "how bad is it?" question, or a hard time limit |
| `--mode deep` | samples pages (default `--pages` 5) | duplicates, broken links, hreflang reciprocity or orphan pages are in question; multi-template sites (home + category + product + checkout) |
| `--pages N` | 5–10 in deep | one page per distinct template, plus the money page. More pages is not more signal; more *templates* is |
| `--repo PATH` | white-box | the checkout is at hand. Unlocks lockfile-grade dependency evidence that a black-box run reports as `DEPS-VERSION-UNDETERMINED` |
| `--axes` | a subset | the client asked one question ("is it accessible?" → `--axes A11Y`), or the clock is tight. **Say in the report which axes you skipped** — the summary lists them in `axesSkipped` |
| `--out DIR` | a run-specific dir | always, so two runs stay comparable side by side |

Defaults exist so the CLI can run unattended. You are not unattended: pick, and
record the reason — it goes into the report as `invocation.rationale`, which is
what lets the client tell a partial scan from a complete one.

Run it, then read only the summary:

```bash
webdiag scan https://client.example --mode deep --pages 8 --out ./diag-2026-09-06
cat ./diag-2026-09-06/summary.json
```

A failed probe narrows the run, it does not end it. Check
`byAxis[].probe.status`: a `failed` axis has no findings *because nothing was
measured*, which is not the same as a clean axis, and the report must not let the
client read it as one.

### 3. Read the summary for judgment

Fields worth your attention, in reading order, are documented in
[`references/summary-fields.md`](references/summary-fields.md). The short version:

- `coverPage` — blocking criticals. These zeroed their axis on purpose. They are
  your top priorities unless you have a specific reason to say otherwise, and
  even then you must rank them.
- `byAxis[].score` + `zeroed` + `zeroedBy` — the arithmetic, already done.
- `byAxis[].findings[]` — severity, `count`, `affected`, `evidence`,
  `remediation`. Quote `remediation` rather than inventing a fix; it is the
  catalog's published contract text.
- `lowConfidence` — never hide these, never score them, never rank them first.
- `axesSkipped` and any `probe.status: "failed"` — the honest limits of the run.
- `rejected` — a probe emitted something the catalog does not know. Worth a
  sentence to the engineering side, not to the client.

**There is no composite score, and you must not compute one.** Averaging six axes
produces a comfortable 71 that hides the `noindex` on production. If asked for
"the number", answer with the axis that is on fire.

### 4. Write the narrative

Write a `narrative.json` matching
[`references/narrative-schema.md`](references/narrative-schema.md). This is where
the value is; budget your effort accordingly.

What separates a report from a translated `--help`:

- **Rank by business consequence, not by severity.** Severity is a property of
  the defect; consequence is a property of the client. A `high` that blocks
  checkout on mobile outranks a `critical` on a page nobody visits — say so
  explicitly when you invert the order, and never drop the blocking one.
- **Group findings into one priority when they share a fix.** Four `PERF-IMG-*`
  findings are one job: "the image pipeline". The client acts on jobs, not IDs.
- **Name the cost in their currency.** Sessions, conversions, support tickets,
  legal exposure, engineering days. "LCP is 4.1 s" is a measurement; "the
  category page takes 4.1 s to show anything on a mid-range Android, which is
  where two thirds of your traffic is" is a reason to act.
- **Say what you could not see.** Skipped axes, failed probes, the ~43% of WCAG
  that needs a human, black-box dependency blind spots. `notMeasured` exists so
  the report cannot be read as a certificate.
- **Keep client copy in Spanish** to match the catalog's published titles and
  remediations. The narrative's own field names stay English.

Length discipline: an executive summary is 2–4 paragraphs; 3–6 priorities is
usually right. Ten priorities is a list, and a list is what you were asked to
replace.

### 5. Build the report

```bash
python3 .agents/skills/webdiag-report/scripts/build_report.py \
  --summary ./diag-2026-09-06/summary.json \
  --narrative ./diag-2026-09-06/narrative.json \
  --out ./diag-2026-09-06/client-report.html
```

`--format md` renders Markdown instead, for pasting into an email or a ticket.
Python 3.9+; standard library only. Exit `0` on success, `3` on refusal, and it
always says which rule you broke.

The output is self-contained — inline CSS, no scripts, no external requests — so
it survives being emailed. It carries the disclaimers straight from the summary;
they are not optional and you cannot edit them out.

Hand the client `client-report.html` (judgment) and, if they have engineers,
`report.html` from the CLI (the full measurement).

## Guardrails

`build_report.py` refuses to render, with exit code `3`, when:

| Refusal | Why it exists |
|---|---|
| `--summary` points inside `raw/` | Rule 1 is mechanical, not an honour system |
| Summary schema is not `webdiag.summary/1` | A newer CLI contract must not be half-rendered |
| A `findingIds` entry is not in the summary | You cannot cite a finding that was not measured |
| A `coverPage` finding is cited by no priority | A blocking critical cannot be quietly demoted |
| Missing `verdict`, `executiveSummary`, or an empty `priorities` | A report without judgment is the thing this layer replaces |
| `axisNotes` names an axis outside the six | Catches a typo before the client sees it |

These are not style checks. Each one is a way the report could lie.

## Files

| Path | What it is |
|---|---|
| `scripts/build_report.py` | Narrative + `summary.json` → client report (HTML or Markdown) |
| `references/narrative-schema.md` | The `webdiag.narrative/1` contract, field by field |
| `references/summary-fields.md` | The `summary.json` fields you read, so you never open the source |
| `examples/narrative.example.json` | A complete narrative for the summary in `examples/` |
| `examples/summary.example.json` | A real `webdiag scan` summary, for a dry run |
