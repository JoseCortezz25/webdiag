# `webdiag.agent-findings/1`

The fase 4 contract: what you write after judging screenshots, so
`build_report.py` can fold it into the same report as `summary.json`, without
letting it pretend to be something axe-core measured.

This file is optional. Produce it only when you actually captured and reviewed
screenshots (see [Screenshot judgment](../SKILL.md#6-screenshot-judgment-fase-4)
in the skill). No screenshots, no file, no `--agent-findings` flag — the report
still renders from `summary.json` and the narrative alone.

## Shape

```jsonc
{
  "schema": "webdiag.agent-findings/1",
  "findings": [
    {
      "id": "A11Y-ALT-NOT-DESCRIPTIVE",     // one of the four ids below, required
      "confidence": "high",                 // optional, default "medium"
      "count": 1,                           // optional, default 1
      "affected": ["img[src='thumb.jpg']"], // optional, selectors or paths
      "evidence": {                         // required, non-empty
        "screenshot": "alt/002.png",
        "alt": "imagen1.jpg",
        "reasoning": "El alt repite el nombre de archivo; no describe el producto."
      }
    }
  ]
}
```

## The only four ids this file may cite

Exactly the phase-4 rows of the catalogue
(`docs/inbox/findings-catalog.md`) — the ones marked "juicio del agente"
because axe-core has no rule for them:

| id | severity | why axe-core can't see it |
|---|---|---|
| `A11Y-ALT-NOT-DESCRIPTIVE` | medium | axe checks that `alt` exists, never what it says |
| `A11Y-FOCUS-NOT-VISIBLE` | high | requires rendering the `:focus` state and looking at it |
| `A11Y-FOCUS-ORDER-ILLOGICAL` | high | requires comparing tab order against the visual layout |
| `A11Y-KEYBOARD-TRAP` | critical, blocking | requires actually pressing Tab repeatedly and watching where focus lands |

`build_report.py` refuses (exit `3`) any other id, and refuses an id the
summary already measured — an agent finding exists only for what the CLI could
not evaluate. Title, severity and remediation copy for these four ids are
fixed inside `build_report.py`; you supply `evidence`, `confidence`, `count`
and `affected` only.

## Field notes

**`evidence`** is required and must be non-empty. This is the guardrail against
an invented finding: point at the screenshot (relative path from
`capture_states.ts`'s manifest) and say, briefly, what in it supports the
finding. `remediation` is not up here — it is fixed catalogue copy, same as
every other finding.

**`confidence`**: visual judgment is not free of doubt the way a DOM query is.
Use `medium` (the default) unless you are certain — a `hover` contrast call
made from a single screenshot is a reasonable `medium`; a keyboard trap you
watched repeat for five Tab presses in a row is `high`.

**Citing these ids in the narrative** works exactly like citing a summary
finding: put the id in `priorities[].findingIds`. `A11Y-KEYBOARD-TRAP` is
`blocking`, so — like a `coverPage` critical — it must be ranked by some
priority or `build_report.py` refuses to render.

**Finding nothing is a valid outcome.** If you checked all four and none
apply, do not write the file at all; do not emit an empty or placeholder
finding. Say what you checked in `narrative.json`'s `axisNotes.A11Y` or
`notMeasured` instead — "se revisaron N estados de foco y M imagenes con alt;
no se encontraron problemas de este tipo" is honest and useful. Manufacturing
a finding to have something to show is exactly what this schema exists to
prevent.
