#!/usr/bin/env python3
"""Build the client-facing report from `summary.json` plus an agent narrative.

This is the last step of layer 3 (spec section 4). The agent writes the judgment
-- what matters for *this* client and in what order -- into a narrative JSON
file; this script marries that judgment to the measured evidence in
`summary.json` and renders one self-contained artifact.

Two rules shape the whole file:

  - **Only `summary.json` is read.** `raw/*.json` is never opened, not even to
    enrich the output. If a number is not in the summary it does not reach the
    client report.
  - **The narrative may prioritise, never invent.** Every finding id the
    narrative cites has to exist in the summary, and every blocking finding the
    summary put on the cover page has to be ranked by the narrative. Both are
    hard errors, because a report that silently drops a blocking critical is
    exactly the failure the scoring override rule exists to prevent.

Copy in the rendered report is Spanish: the finding catalog's published titles
and remediations are Spanish and they are the contract, so an English shell
around them would read as a bug to the client it is written for.

Usage:
    build_report.py --summary out/summary.json \\
                    --narrative narrative.json \\
                    --out out/client-report.html [--format html|md]
"""

from __future__ import annotations

import argparse
import html
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Contract versions this script accepts. Both are pinned on purpose: a summary
# from a future CLI is refused loudly instead of half-rendered.
SUMMARY_SCHEMA = "webdiag.summary/1"
NARRATIVE_SCHEMA = "webdiag.narrative/1"

# Mirrors src/catalog/taxonomy.ts. Kept in lockstep by the contract test in
# src/scan/skill-contract.test.ts.
AXES = ("PERF", "A11Y", "SEO", "DEPS", "SEC", "AGENT")
SEVERITIES = ("critical", "high", "medium", "low", "info")

AXIS_LABEL = {
    "PERF": "Rendimiento",
    "A11Y": "Accesibilidad",
    "SEO": "SEO tecnico",
    "DEPS": "Dependencias",
    "SEC": "Seguridad",
    "AGENT": "Agent-readiness",
}

SEVERITY_LABEL = {
    "critical": "Critico",
    "high": "Alto",
    "medium": "Medio",
    "low": "Bajo",
    "info": "Informativo",
}

CONFIDENCE_LABEL = {
    "high": "confianza alta",
    "medium": "confianza media",
    "low": "confianza baja",
}

EFFORT_LABEL = {"low": "Esfuerzo bajo", "medium": "Esfuerzo medio", "high": "Esfuerzo alto"}

HORIZON_LABEL = {
    "now": "Ahora",
    "next": "Siguiente ciclo",
    "later": "Mas adelante",
}

STATE_LABEL = {
    "critical": "Critico",
    "at-risk": "En riesgo",
    "solid": "Solido",
}

EFFORTS = tuple(EFFORT_LABEL)
HORIZONS = tuple(HORIZON_LABEL)
STATES = tuple(STATE_LABEL)

EXIT_OK = 0
EXIT_USAGE = 1
EXIT_FAILED = 3


class ReportError(Exception):
    """A refusal the operator can act on. Never a stack trace at the client."""


# --------------------------------------------------------------------------- #
# Loading and validation
# --------------------------------------------------------------------------- #


def load_json(path: Path, label: str) -> Any:
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError as cause:
        raise ReportError(f"{label} no existe: {path}") from cause
    except json.JSONDecodeError as cause:
        raise ReportError(f"{label} no es JSON valido ({path}): {cause}") from cause


def load_summary(path: Path) -> dict[str, Any]:
    # The skill is forbidden from reading raw probe output (spec section 4). The
    # check is cheap and catches the mistake at the only place it can be caught
    # automatically: someone pointing --summary at a raw dump.
    if "raw" in path.parts[:-1]:
        raise ReportError(
            f"--summary apunta dentro de raw/ ({path}). La capa de agente solo lee summary.json."
        )

    summary = load_json(path, "El summary")

    if not isinstance(summary, dict):
        raise ReportError("El summary debe ser un objeto JSON.")

    schema = summary.get("schema")
    if schema != SUMMARY_SCHEMA:
        raise ReportError(
            f"Schema de summary no soportado: {schema!r}. Se esperaba {SUMMARY_SCHEMA!r}."
        )

    for key in ("target", "byAxis", "coverPage", "disclaimers", "totals"):
        if key not in summary:
            raise ReportError(f"El summary no trae el campo obligatorio '{key}'.")

    return summary


def require(node: dict[str, Any], key: str, where: str) -> Any:
    if key not in node or node[key] in (None, "", []):
        raise ReportError(f"La narrativa no trae '{key}' en {where}.")
    return node[key]


def load_narrative(path: Path) -> dict[str, Any]:
    narrative = load_json(path, "La narrativa")

    if not isinstance(narrative, dict):
        raise ReportError("La narrativa debe ser un objeto JSON.")

    schema = narrative.get("schema")
    if schema != NARRATIVE_SCHEMA:
        raise ReportError(
            f"Schema de narrativa no soportado: {schema!r}. Se esperaba {NARRATIVE_SCHEMA!r}."
        )

    require(narrative, "executiveSummary", "la raiz")
    verdict = require(narrative, "verdict", "la raiz")

    if not isinstance(verdict, dict):
        raise ReportError("'verdict' debe ser un objeto con 'state' y 'headline'.")

    state = require(verdict, "state", "verdict")
    if state not in STATES:
        raise ReportError(f"verdict.state invalido: {state!r}. Valores: {', '.join(STATES)}.")
    require(verdict, "headline", "verdict")

    priorities = narrative.get("priorities")
    if not isinstance(priorities, list) or len(priorities) == 0:
        raise ReportError("La narrativa debe traer al menos una prioridad en 'priorities'.")

    for index, priority in enumerate(priorities):
        where = f"priorities[{index}]"
        if not isinstance(priority, dict):
            raise ReportError(f"{where} debe ser un objeto.")
        require(priority, "title", where)
        require(priority, "businessImpact", where)
        require(priority, "recommendation", where)
        ids = require(priority, "findingIds", where)
        if not isinstance(ids, list) or not all(isinstance(item, str) for item in ids):
            raise ReportError(f"{where}.findingIds debe ser una lista de ids del catalogo.")
        effort = priority.get("effort")
        if effort is not None and effort not in EFFORTS:
            raise ReportError(f"{where}.effort invalido: {effort!r}. Valores: {', '.join(EFFORTS)}.")
        horizon = priority.get("horizon")
        if horizon is not None and horizon not in HORIZONS:
            raise ReportError(
                f"{where}.horizon invalido: {horizon!r}. Valores: {', '.join(HORIZONS)}."
            )

    axis_notes = narrative.get("axisNotes", {})
    if not isinstance(axis_notes, dict):
        raise ReportError("'axisNotes' debe ser un objeto {EJE: texto}.")
    unknown_axes = sorted(set(axis_notes) - set(AXES))
    if unknown_axes:
        raise ReportError(
            f"axisNotes menciona ejes que no existen: {', '.join(unknown_axes)}. "
            f"Ejes validos: {', '.join(AXES)}."
        )

    return narrative


# --------------------------------------------------------------------------- #
# Cross-checks between narrative and measurement
# --------------------------------------------------------------------------- #


def index_findings(summary: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Every finding in the summary, keyed by catalog id.

    Findings appear more than once (an axis lists a finding another axis owns as
    a mention), so later copies are ignored rather than overwriting.
    """
    findings: dict[str, dict[str, Any]] = {}

    def absorb(items: Any) -> None:
        if not isinstance(items, list):
            return
        for item in items:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                findings.setdefault(item["id"], item)

    absorb(summary.get("coverPage"))
    absorb(summary.get("lowConfidence"))

    for axis in summary.get("byAxis", []):
        absorb(axis.get("findings"))
        absorb(axis.get("lowConfidence"))
        absorb(axis.get("mentions"))

    return findings


def check_priorities(narrative: dict[str, Any], summary: dict[str, Any]) -> None:
    """Refuse a narrative that invents evidence or buries a blocking critical."""
    measured = index_findings(summary)
    cited: set[str] = set()

    for index, priority in enumerate(narrative["priorities"]):
        for finding_id in priority["findingIds"]:
            if finding_id not in measured:
                raise ReportError(
                    f"priorities[{index}] cita '{finding_id}', que no esta en el summary. "
                    "La narrativa prioriza lo medido, no agrega hallazgos."
                )
            cited.add(finding_id)

    blocking = [item["id"] for item in summary.get("coverPage", []) if isinstance(item, dict)]
    unranked = [finding_id for finding_id in blocking if finding_id not in cited]

    if unranked:
        raise ReportError(
            "Estos hallazgos bloqueantes estan en portada del summary y ninguna prioridad "
            f"los cita: {', '.join(unranked)}. Un bloqueante no puede quedar sin priorizar."
        )


def ranked_priorities(narrative: dict[str, Any]) -> list[dict[str, Any]]:
    """Priorities in the order the client should read them.

    An explicit `rank` wins; otherwise the array order is the ranking. Sorting is
    stable, so a partially ranked list stays predictable instead of shuffling.
    """
    ordered = sorted(
        enumerate(narrative["priorities"]),
        key=lambda pair: (pair[1].get("rank", pair[0] + 1), pair[0]),
    )
    return [priority for _, priority in ordered]


# --------------------------------------------------------------------------- #
# Rendering — shared helpers
# --------------------------------------------------------------------------- #


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def axis_label(axis: str) -> str:
    return AXIS_LABEL.get(axis, axis)


def paragraphs(text: str) -> list[str]:
    return [block.strip() for block in str(text).split("\n\n") if block.strip()]


def evidence_lines(finding: dict[str, Any]) -> list[tuple[str, str]]:
    evidence = finding.get("evidence") or {}
    if not isinstance(evidence, dict):
        return []
    return [
        (key, value if isinstance(value, str) else json.dumps(value, ensure_ascii=False))
        for key, value in evidence.items()
    ]


# --------------------------------------------------------------------------- #
# Rendering — HTML
# --------------------------------------------------------------------------- #

STYLES = """
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--fg:#e6edf3;--dim:#9198a1;--accent:#58a6ff;
--critical:#f85149;--high:#ff7b72;--medium:#d29922;--low:#8b949e;--info:#58a6ff;--good:#3fb950}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:900px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:27px;margin:0 0 4px}
h2{font-size:19px;margin:0 0 10px}
h3{font-size:13px;margin:30px 0 8px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
h4{font-size:15px;margin:0}
p{margin:0 0 12px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;background:#22272e;padding:1px 5px;border-radius:4px}
a{color:var(--accent)}
.target{color:var(--dim);margin:0 0 24px;font-size:13.5px}
.verdict{border:1px solid var(--line);border-left-width:4px;border-radius:10px;background:var(--panel);padding:18px 20px;margin:0 0 24px}
.verdict.critical{border-left-color:var(--critical)}
.verdict.at-risk{border-left-color:var(--medium)}
.verdict.solid{border-left-color:var(--good)}
.verdict .state{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim)}
.verdict h2{margin:4px 0 10px}
.context{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin:0 0 24px;font-size:13.5px}
.context .kv{display:flex;gap:10px;padding:3px 0}
.context .k{color:var(--dim);text-transform:uppercase;font-size:11px;letter-spacing:.05em;min-width:110px}
.priority{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:0 0 12px}
.priority header{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px}
.rank{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;border-radius:999px;background:#22272e;border:1px solid var(--line);font-size:13px;margin-right:8px}
.badges{display:flex;gap:6px;flex-wrap:wrap}
.badge{font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.badge.sev-critical,.badge.blocking{color:var(--critical);border-color:var(--critical)}
.badge.sev-high{color:var(--high);border-color:var(--high)}
.badge.sev-medium{color:var(--medium);border-color:var(--medium)}
.badge.sev-low{color:var(--low)}
.badge.sev-info{color:var(--info);border-color:var(--info)}
.lede{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin:14px 0 2px}
.support{border-top:1px dashed var(--line);margin-top:14px;padding-top:10px}
.finding{font-size:13px;padding:8px 0;border-bottom:1px solid var(--line)}
.finding:last-child{border-bottom:none}
.finding .head{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;justify-content:space-between}
.evidence{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:6px 0 0;font-size:12.5px}
.kv{display:contents}
.k{color:var(--dim);text-transform:uppercase;font-size:11px;letter-spacing:.05em}
.v{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}
.axis-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:0 0 12px}
.axis-card{display:flex;flex-direction:column;gap:2px;padding:14px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
.axis-card.good{border-left:3px solid var(--good)}
.axis-card.fair{border-left:3px solid var(--medium)}
.axis-card.poor{border-left:3px solid var(--high)}
.axis-card.zeroed{border-left:3px solid var(--critical)}
.axis-name{font-size:13px;color:var(--dim)}
.axis-score{font-size:29px;font-weight:600;line-height:1.1}
.axis-score small{font-size:14px;color:var(--dim);font-weight:400}
.axis-note{font-size:12px;color:var(--critical)}
.axis-comment{font-size:13px;color:var(--fg);margin-top:6px}
.probe-failed{font-size:12px;color:var(--medium);margin:4px 0 0}
.no-composite{color:var(--dim);font-size:13px;margin:0 0 28px;border-top:1px dashed var(--line);padding-top:10px}
.disclaimers{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--medium);border-radius:8px;padding:14px 18px;margin:24px 0 0}
.disclaimers ul,.list ul{margin:0;padding-left:18px}
.disclaimers li{color:var(--dim);font-size:13.5px}
.list li{margin-bottom:6px}
footer{margin-top:44px;border-top:1px solid var(--line);padding-top:16px;color:var(--dim);font-size:12.5px}
"""


def html_finding(finding: dict[str, Any]) -> str:
    badges = [
        f'<span class="badge sev-{esc(finding.get("severity", "info"))}">'
        f'{esc(SEVERITY_LABEL.get(finding.get("severity", ""), finding.get("severity", "")))}</span>',
        f'<span class="badge">{esc(CONFIDENCE_LABEL.get(finding.get("confidence", ""), finding.get("confidence", "")))}</span>',
    ]
    if finding.get("count", 1) > 1:
        badges.append(f'<span class="badge">{esc(finding["count"])} ocurrencias</span>')
    if finding.get("blocking"):
        badges.append('<span class="badge blocking">Bloqueante</span>')

    evidence = "".join(
        f'<div class="kv"><span class="k">{esc(key)}</span><span class="v">{esc(value)}</span></div>'
        for key, value in evidence_lines(finding)
    )

    affected = finding.get("affected") or []
    affected_html = (
        ""
        if not affected
        else '<p class="lede">Donde</p><p>'
        + " ".join(f"<code>{esc(path)}</code>" for path in affected)
        + "</p>"
    )

    doc_ref = finding.get("docRef")
    doc_html = "" if not doc_ref else f'<p><a href="{esc(doc_ref)}">Referencia</a></p>'

    return "".join(
        [
            '<div class="finding">',
            '<div class="head">',
            f'<h4>{esc(finding.get("title") or finding.get("id", ""))}</h4>',
            f'<div class="badges">{"".join(badges)}</div>',
            "</div>",
            f'<p><code>{esc(finding.get("id", ""))}</code> · eje '
            f'{esc(axis_label(finding.get("ownerAxis", "")))}</p>',
            affected_html,
            "" if not evidence else f'<div class="evidence">{evidence}</div>',
            f'<p class="lede">Como se corrige</p><p>{esc(finding.get("remediation", ""))}</p>',
            doc_html,
            "</div>",
        ]
    )


def html_priority(
    position: int, priority: dict[str, Any], measured: dict[str, dict[str, Any]]
) -> str:
    badges = []
    horizon = priority.get("horizon")
    if horizon:
        badges.append(f'<span class="badge">{esc(HORIZON_LABEL[horizon])}</span>')
    effort = priority.get("effort")
    if effort:
        badges.append(f'<span class="badge">{esc(EFFORT_LABEL[effort])}</span>')

    support = "".join(html_finding(measured[fid]) for fid in priority["findingIds"])

    return "".join(
        [
            '<article class="priority">',
            "<header>",
            f'<h4><span class="rank">{position}</span>{esc(priority["title"])}</h4>',
            f'<div class="badges">{"".join(badges)}</div>',
            "</header>",
            '<p class="lede">Por que importa para el negocio</p>',
            "".join(f"<p>{esc(block)}</p>" for block in paragraphs(priority["businessImpact"])),
            '<p class="lede">Recomendacion</p>',
            "".join(f"<p>{esc(block)}</p>" for block in paragraphs(priority["recommendation"])),
            f'<div class="support"><p class="lede">Evidencia medida</p>{support}</div>',
            "</article>",
        ]
    )


def html_axis_card(axis: dict[str, Any], note: str | None) -> str:
    score = axis.get("score", 0)
    if axis.get("zeroed"):
        state = "zeroed"
    elif score >= 90:
        state = "good"
    elif score >= 70:
        state = "fair"
    else:
        state = "poor"

    probe = axis.get("probe") or {}
    probe_html = (
        ""
        if probe.get("status") != "failed"
        else f'<p class="probe-failed">Probe no disponible: '
        f'{esc(probe.get("error") or "error desconocido")}</p>'
    )

    return "".join(
        [
            f'<div class="axis-card {state}">',
            f'<span class="axis-name">{esc(axis_label(axis.get("axis", "")))}</span>',
            f'<span class="axis-score">{esc(score)}<small>/{esc(axis.get("maxScore", 100))}</small></span>',
            '<span class="axis-note">Anulado por hallazgo bloqueante</span>'
            if axis.get("zeroed")
            else "",
            probe_html,
            "" if not note else f'<p class="axis-comment">{esc(note)}</p>',
            "</div>",
        ]
    )


def html_list_section(title: str, items: list[Any]) -> str:
    if not items:
        return ""
    entries = "".join(f"<li>{esc(item)}</li>" for item in items)
    return f'<h3>{esc(title)}</h3><div class="list"><ul>{entries}</ul></div>'


def render_html(narrative: dict[str, Any], summary: dict[str, Any], generated_at: str) -> str:
    target = summary.get("target", {})
    measured = index_findings(summary)
    priorities = ranked_priorities(narrative)
    axis_notes = narrative.get("axisNotes", {})
    context = narrative.get("context") or {}
    invocation = narrative.get("invocation") or {}
    verdict = narrative["verdict"]

    context_rows = "".join(
        f'<div class="kv"><span class="k">{esc(label)}</span><span>{esc(value)}</span></div>'
        for label, value in (
            ("Negocio", context.get("business")),
            ("Objetivo", context.get("objective")),
            ("Restricciones", context.get("constraints")),
            ("Medicion", invocation.get("command")),
            ("Por que asi", invocation.get("rationale")),
        )
        if value
    )

    low_confidence = summary.get("lowConfidence") or []
    low_html = (
        ""
        if not low_confidence
        else "<h3>Hallazgos de confianza baja</h3>"
        "<p>Se listan siempre y no afectan ningun puntaje. Requieren verificacion manual "
        "antes de actuar sobre ellos.</p>"
        + "".join(html_finding(finding) for finding in low_confidence)
    )

    audience = narrative.get("preparedFor") or target.get("url", "")

    return f"""<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="webdiag-report skill (build_report.py)">
<title>Diagnostico tecnico priorizado — {esc(target.get("url", ""))}</title>
<style>{STYLES}</style>
</head>
<body>
<main>
<h1>Diagnostico tecnico priorizado</h1>
<p class="target"><code>{esc(target.get("url", ""))}</code> · modo <code>{esc(target.get("mode", ""))}</code>
· {esc(target.get("pages", 1))} pagina(s) · catalogo v{esc(summary.get("catalogVersion", ""))}
· preparado para {esc(audience)} · {esc(generated_at)}</p>

<section class="verdict {esc(verdict["state"])}">
<p class="state">{esc(STATE_LABEL[verdict["state"]])}</p>
<h2>{esc(verdict["headline"])}</h2>
{"".join(f"<p>{esc(block)}</p>" for block in paragraphs(narrative["executiveSummary"]))}
</section>

{f'<section class="context">{context_rows}</section>' if context_rows else ""}

<h3>Que atender primero</h3>
{"".join(html_priority(index + 1, priority, measured) for index, priority in enumerate(priorities))}

<h3>Estado por eje</h3>
<div class="axis-grid">{"".join(
    html_axis_card(axis, axis_notes.get(axis.get("axis"))) for axis in summary.get("byAxis", [])
)}</div>
<p class="no-composite">Cada eje se puntua de forma independiente sobre
{esc(summary.get("scoring", {}).get("maxAxisScore", 100))}. No existe un numero unico que los
combine: promediarlos enterraria el hallazgo que importa.</p>

{low_html}

{html_list_section("Lo que este diagnostico no pudo ver", narrative.get("notMeasured") or [])}
{html_list_section("Siguientes pasos", narrative.get("nextSteps") or [])}

<div class="disclaimers"><ul>{"".join(
    f"<li>{esc(line)}</li>" for line in summary.get("disclaimers", [])
)}</ul></div>

<footer>
<p>Hallazgos medidos: {esc(summary.get("totals", {}).get("findings", 0))} ·
puntuados: {esc(summary.get("totals", {}).get("scored", 0))} ·
confianza baja: {esc(summary.get("totals", {}).get("lowConfidence", 0))}.
Medicion por <code>webdiag</code> (catalogo {esc(summary.get("catalogVersion", ""))});
priorizacion y redaccion por la skill <code>webdiag-report</code>.</p>
</footer>
</main>
</body>
</html>
"""


# --------------------------------------------------------------------------- #
# Rendering — Markdown
# --------------------------------------------------------------------------- #


def md_blocks(text: str) -> list[str]:
    """Paragraphs with the blank line Markdown needs between them."""
    lines: list[str] = []
    for block in paragraphs(text):
        lines.extend([block, ""])
    return lines


def md_finding(finding: dict[str, Any]) -> list[str]:
    badges = [SEVERITY_LABEL.get(finding.get("severity", ""), finding.get("severity", ""))]
    badges.append(CONFIDENCE_LABEL.get(finding.get("confidence", ""), finding.get("confidence", "")))
    if finding.get("count", 1) > 1:
        badges.append(f'{finding["count"]} ocurrencias')
    if finding.get("blocking"):
        badges.append("bloqueante")

    title = finding.get("title")
    headline = f' — {title}' if title else ""
    lines = [f'- **`{finding.get("id", "")}`**{headline} _({" · ".join(badges)})_']

    affected = finding.get("affected") or []
    if affected:
        lines.append(f'  - Donde: {", ".join(f"`{path}`" for path in affected)}')
    for key, value in evidence_lines(finding):
        lines.append(f"  - {key}: `{value}`")
    lines.append(f'  - Como se corrige: {finding.get("remediation", "")}')
    return lines


def render_markdown(narrative: dict[str, Any], summary: dict[str, Any], generated_at: str) -> str:
    target = summary.get("target", {})
    measured = index_findings(summary)
    verdict = narrative["verdict"]
    axis_notes = narrative.get("axisNotes", {})
    invocation = narrative.get("invocation") or {}
    context = narrative.get("context") or {}

    lines: list[str] = [
        "# Diagnostico tecnico priorizado",
        "",
        f'`{target.get("url", "")}` · modo `{target.get("mode", "")}` · '
        f'{target.get("pages", 1)} pagina(s) · catalogo v{summary.get("catalogVersion", "")} · '
        f"{generated_at}",
        "",
        f'## {STATE_LABEL[verdict["state"]]} — {verdict["headline"]}',
        "",
    ]
    lines.extend(md_blocks(narrative["executiveSummary"]))

    for label, value in (
        ("Negocio", context.get("business")),
        ("Objetivo", context.get("objective")),
        ("Restricciones", context.get("constraints")),
        ("Medicion", f'`{invocation.get("command")}`' if invocation.get("command") else None),
        ("Por que asi", invocation.get("rationale")),
    ):
        if value:
            lines.append(f"- **{label}:** {value}")
    lines.append("")

    lines.extend(["## Que atender primero", ""])
    for index, priority in enumerate(ranked_priorities(narrative)):
        tags = [HORIZON_LABEL[priority["horizon"]]] if priority.get("horizon") else []
        if priority.get("effort"):
            tags.append(EFFORT_LABEL[priority["effort"]])
        suffix = f' _({" · ".join(tags)})_' if tags else ""
        lines.extend([f'### {index + 1}. {priority["title"]}{suffix}', ""])
        lines.extend(md_blocks(priority["businessImpact"]))
        lines.append("**Recomendacion.** " + " ".join(paragraphs(priority["recommendation"])))
        lines.extend(["", "Evidencia medida:", ""])
        for finding_id in priority["findingIds"]:
            lines.extend(md_finding(measured[finding_id]))
        lines.append("")

    lines.extend(["## Estado por eje", "", "| Eje | Puntaje | Nota |", "|---|---|---|"])
    for axis in summary.get("byAxis", []):
        score = f'{axis.get("score", 0)}/{axis.get("maxScore", 100)}'
        if axis.get("zeroed"):
            score += " (anulado)"
        note = (axis_notes.get(axis.get("axis")) or "").replace("\n", " ")
        lines.append(f'| {axis_label(axis.get("axis", ""))} | {score} | {note} |')
    lines.extend(
        [
            "",
            "Cada eje se puntua de forma independiente. No existe un numero unico que los combine.",
            "",
        ]
    )

    low_confidence = summary.get("lowConfidence") or []
    if low_confidence:
        lines.extend(
            [
                "## Hallazgos de confianza baja",
                "",
                "Se listan siempre y no afectan ningun puntaje.",
                "",
            ]
        )
        for finding in low_confidence:
            lines.extend(md_finding(finding))
        lines.append("")

    for title, items in (
        ("Lo que este diagnostico no pudo ver", narrative.get("notMeasured") or []),
        ("Siguientes pasos", narrative.get("nextSteps") or []),
    ):
        if items:
            lines.extend([f"## {title}", ""])
            lines.extend(f"- {item}" for item in items)
            lines.append("")

    lines.extend(["## Alcance y limites", ""])
    lines.extend(f"- {line}" for line in summary.get("disclaimers", []))
    lines.append("")

    totals = summary.get("totals", {})
    lines.append(
        f'Hallazgos medidos: {totals.get("findings", 0)} · puntuados: {totals.get("scored", 0)} · '
        f'confianza baja: {totals.get("lowConfidence", 0)}. '
        "Medicion por `webdiag`; priorizacion y redaccion por la skill `webdiag-report`."
    )

    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="build_report.py",
        description="Build the client report from summary.json plus an agent narrative.",
    )
    parser.add_argument("--summary", required=True, type=Path, help="Path to summary.json")
    parser.add_argument(
        "--narrative", required=True, type=Path, help="Path to the narrative JSON written by the agent"
    )
    parser.add_argument("--out", required=True, type=Path, help="Where to write the report")
    parser.add_argument("--format", choices=("html", "md"), default="html", help="Output format")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    try:
        args = parse_args(argv)
    except SystemExit as cause:  # argparse already explained itself
        return EXIT_USAGE if cause.code else EXIT_OK

    try:
        summary = load_summary(args.summary)
        narrative = load_narrative(args.narrative)
        check_priorities(narrative, summary)

        generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
        render = render_html if args.format == "html" else render_markdown
        document = render(narrative, summary, generated_at)

        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(document, encoding="utf-8")
    except ReportError as error:
        print(f"build_report: {error}", file=sys.stderr)
        return EXIT_FAILED

    priorities = len(narrative["priorities"])
    print(f"build_report: {args.out} ({priorities} prioridad(es), formato {args.format})")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
