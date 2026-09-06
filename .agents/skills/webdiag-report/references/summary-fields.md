# `webdiag.summary/1` — the fields you read

This exists so you never have to open the CLI source, and never have to open
`raw/*.json`. Everything a client report can honestly say is here.

## Top level

| Field | What it gives you |
|---|---|
| `schema` | `"webdiag.summary/1"`. Anything else: stop, the contract moved |
| `catalogVersion` | Finding-catalog version. Two runs are only comparable at the same version |
| `target` | `{ url, mode, pages, repo }` — what was actually scanned, including whether it was white-box |
| `scoring` | `{ model: "independent-per-axis", maxAxisScore: 100, composite: null }`. `composite: null` is stated, not omitted, so nobody fills it in |
| `axesEvaluated` / `axesSkipped` | Which of the six ran. Skipped axes must reach the report as a limit, not as silence |
| `coverPage` | Blocking criticals. Each zeroed its axis. Every one must be ranked in the narrative |
| `lowConfidence` | Listed, never scored, never hidden. Needs human verification before anyone acts |
| `rejected` | A probe emitted an id the catalog does not publish. Engineering signal, not client copy |
| `byAxis` | One entry per evaluated axis, in catalog order |
| `disclaimers` | Rendered verbatim by `build_report.py`. Not editable, not optional |
| `totals` | `{ findings, scored, lowConfidence }` |

## `byAxis[]`

| Field | What it gives you |
|---|---|
| `axis` | `PERF` `A11Y` `SEO` `DEPS` `SEC` `AGENT` |
| `score` / `maxScore` | 0–100. Independent. Do **not** average across axes |
| `zeroed` / `zeroedBy` | `true` plus the ids that forced it. The axis was not "very bad", it was overridden |
| `probe` | `{ axis, tool, status, error }`. `status: "failed"` means *not measured* — never report it as clean |
| `counts` | `{ scored, lowConfidence, mentions, bySeverity }` |
| `deductions` | `[{ id, points }]` — the arithmetic behind the score, already done |
| `findings` | Scored findings this axis owns |
| `lowConfidence` | Owned but held out of the score |
| `mentions` | Owned by another axis, shown here for context, deducted there. Do not double-count |

## Finding objects

Same shape everywhere they appear (`coverPage`, `byAxis[].findings`,
`byAxis[].lowConfidence`, `byAxis[].mentions`, top-level `lowConfidence`):

| Field | What it gives you |
|---|---|
| `id` | Stable catalog id. This is the contract; it never changes meaning |
| `title` | Published Spanish headline. May be absent — fall back to the id |
| `severity` | `critical` `high` `medium` `low` `info`. A property of the defect, not of the client |
| `confidence` | `high` `medium` `low`. Separate from severity on purpose: it is the false-positive valve |
| `count` | One finding repeated on N pages is one entry with `count: N` |
| `affected` | Paths. Useful concrete detail for the client |
| `evidence` | Free-form key/value from the probe. Rendered as-is |
| `remediation` | The catalog's published fix text. Quote it; do not rewrite it |
| `source` / `tool` | Which probe and which tool version said so |
| `ownerAxis` | The axis that scores it, which is not always the axis of the id prefix |
| `blocking` | `true` → it is on the cover page and zeroed its axis |
| `docRef` | Optional external reference. Absent when the catalog has none |

## Reading rules

- **No composite.** `scoring.composite` is `null` by design (spec §5.1). If a
  client asks for one number, name the axis that is on fire instead.
- **A zero is not a bad average.** `zeroed: true` means one blocking critical
  fixed the axis at 0 so it could not be averaged away. Explain the finding, not
  the number.
- **`confidence: low` never ranks first.** It is listed so the report is honest,
  not so it drives action.
- **A failed probe is a hole, not a pass.** An axis with no findings and
  `probe.status: "failed"` measured nothing.
- **Mentions are context.** A finding listed under an axis it does not own has
  already been deducted elsewhere. Counting it twice inflates the story.
