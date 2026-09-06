# `webdiag.narrative/1`

The contract between your judgment and `build_report.py`. One JSON object.

Everything here is judgment: none of it can be derived from `summary.json`, which
is why the script cannot write it for you. Conversely, nothing measurable belongs
here — scores, counts, affected paths and remediations are pulled from the
summary at render time, so copying them into the narrative only creates a second
version that can drift.

## Shape

```jsonc
{
  "schema": "webdiag.narrative/1",     // required, exact
  "preparedFor": "Tienda Ejemplo S.A.", // optional, shown in the header

  "context": {                          // optional, all fields optional
    "business": "…",                    // what the site does commercially
    "objective": "…",                   // what the client asked for
    "constraints": "…"                  // budget, deadline, frozen stack
  },

  "invocation": {                       // optional but strongly recommended
    "command": "webdiag scan … --mode deep --pages 8",
    "rationale": "…"                    // why this mode/axes/pages
  },

  "verdict": {                          // required
    "state": "critical | at-risk | solid",
    "headline": "…"                     // one sentence, the client's language
  },

  "executiveSummary": "…\n\n…",         // required, 2–4 paragraphs, \n\n separated

  "priorities": [                       // required, at least one
    {
      "rank": 1,                        // optional; array order is used if absent
      "title": "…",                     // the job, not the finding id
      "findingIds": ["SEO-NOINDEX-UNINTENDED"],
      "businessImpact": "…",            // required — cost in the client's currency
      "recommendation": "…",            // required — what to do, who does it
      "effort": "low | medium | high",  // optional
      "horizon": "now | next | later"   // optional
    }
  ],

  "axisNotes": { "PERF": "…" },         // optional, keys ⊂ PERF A11Y SEO DEPS SEC AGENT
  "notMeasured": ["…"],                 // optional, list of honest limits
  "nextSteps": ["…"]                    // optional, list
}
```

## Field notes

**`verdict.state`** drives the accent colour of the cover block. Pick `critical`
when something on the cover page of the summary is actively costing the client
today; `at-risk` when the defects are real but not yet bleeding; `solid` when the
findings are maintenance. Do not use `solid` while `coverPage` is non-empty.

**`executiveSummary`** is split on blank lines into paragraphs. Write it for
someone who will read this paragraph and forward the file. No IDs, no scores, no
tool names.

**`priorities[].title`** names the job: "Recuperar la indexabilidad de la home",
not "SEO-NOINDEX-UNINTENDED". Several findings that share one fix belong in one
priority — that is the point of the array being shorter than the finding list.

**`priorities[].findingIds`** must all exist in the summary, and every id in the
summary's `coverPage` must appear in some priority. Both are enforced. Ordinary
findings may be left out: not every measurement deserves the client's attention,
and choosing is the job.

**`priorities[].businessImpact`** is the field that decides whether this is a
report or a translated `--help`. Consequence, audience, money, risk. If it could
be written without knowing the client, rewrite it.

**`priorities[].recommendation`** is what to do, at the granularity of a task
somebody could pick up. The catalog's `remediation` text is rendered underneath
each finding automatically, so do not repeat it — say who does it, in what order,
and what to verify afterwards.

**`axisNotes`** is one short line per axis, shown on the score card. Use it to
explain a number that would otherwise be misread: an axis at 0 by override, an
axis at 100 whose probe failed, an axis you skipped on purpose.

**`notMeasured`** is not a disclaimer. The summary's own disclaimers are rendered
separately and always. This field is about *this run*: axes in `axesSkipped`,
probes with `status: "failed"`, black-box dependency limits, the ~43% of WCAG
that needs a human, anything behind a login.

## Client copy is Spanish

Every string that reaches the report is client-facing and Spanish, matching the
catalog's published titles and remediations. The field names above stay English,
like the rest of the codebase.
