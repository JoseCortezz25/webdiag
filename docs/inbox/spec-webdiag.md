# Spec — Sistema de diagnóstico técnico automatizado de sitios web

**Estado:** aprobada con ajustes (ver §10) — en implementación, tickets publicados en GitHub
**Fecha:** 2026-09-05
**Última actualización:** 2026-09-06 — resueltas las decisiones abiertas de pesos, dedup, confidence y el hallazgo A11Y-FORM-LABEL-MISSING
**Origen:** síntesis de conversación de diseño + informe de investigación previo

---

## 1. Problema

Los diagnósticos técnicos de sitios de clientes hoy se hacen a mano: cada persona corre las herramientas que conoce, en el orden que se le ocurre, y redacta el informe desde cero. Consecuencias: el resultado depende de quién lo haga, no es reproducible, no se puede comparar contra una medición anterior, y consume horas que no se facturan proporcionalmente.

Se necesita que un diagnóstico completo sea una operación de un comando, con resultado determinístico y comparable en el tiempo.

## 2. Objetivos

- Ejecutar un diagnóstico técnico completo de una URL en **menos de 6 minutos** en modo rápido.
- Producir **dos capas de salida**: JSON crudo estructurado (para máquinas y para archivo) y reporte HTML autocontenido (para el cliente).
- Que dos corridas del mismo sitio, con las mismas versiones de herramientas, produzcan **el mismo JSON**.
- Poder responder "¿mejoró desde la última auditoría?" con números defendibles.
- Que el sistema funcione **sin IA** para la medición, y use IA solo donde hace falta criterio.

## 3. No-objetivos

- No es un monitor continuo ni un sistema de alertas.
- No sustituye una auditoría formal de accesibilidad con revisión humana (WCAG exige juicio en ~43% de criterios).
- No hace escaneo activo de seguridad ni pentesting (solo checks pasivos).
- No emite juicios legales de cumplimiento (EAA, ADA).
- No crawlea sitios completos en el MVP.

---

## 4. Arquitectura

Tres capas con responsabilidades separadas. La separación es deliberada: permite testear la medición sin llamadas al modelo.

```
CAPA 1 — PROBES (bash/python, sin IA, paralelos)
  entrada: URL y/o path del repo
  salida:  raw/<eje>.json  (formato nativo de cada herramienta)
  reglas:  idempotentes · sin estado · sin rutas absolutas
           ningún fallo de probe tumba la corrida

CAPA 2 — NORMALIZADOR (python, sin IA, determinístico)
  entrada: raw/*.json
  salida:  findings.json (IDs del catálogo) + summary.json + scores
  reglas:  toda la lógica de traducción y puntuación vive aquí

CAPA 3 — AGENTE (Claude + skill)
  entrada: summary.json ÚNICAMENTE (nunca los crudos)
  aporta:  priorización según negocio · redacción para cliente ·
           evaluación del 43% de a11y no automatizable (fase 4)
  salida:  dispara build_report.py con su narrativa
```

### 4.1 Dos artefactos, no uno

| | `webdiag` (CLI) | Skill de Claude |
|---|---|---|
| Repo | propio, versionado y publicable | instala el CLI como dependencia |
| Corre sin IA | sí | no |
| Responsabilidad | **medir** | **decidir y explicar** |
| Usable en CI | sí | no |
| Testeable con fixtures | sí | no aplica |

Decidir cómo invocar el CLI (modo, ejes, nº de páginas) depende de contexto que solo existe en la conversación. Interpretar 40 hallazgos según el negocio del cliente es criterio, no reglas. Por eso la skill no es una capa de traducción del `--help`.

### 4.2 Interfaz del CLI

```
webdiag scan <url> [--repo PATH] [--mode quick|deep] [--axes ...]
                   [--pages N] [--out DIR]
```

Salida en `DIR/`: `raw/`, `findings.json`, `summary.json`, `report.html`, `meta.json`.

---

## 5. Alcance funcional

### 5.1 Ejes (6)

**Decisión (2026-09-06): sin score agregado entre ejes.** Cada eje se evalúa y reporta de forma independiente, con su propio puntaje calculado a partir de las deducciones por severidad del catálogo y la regla de override aplicada por eje (§6). No existe un número compuesto que combine los seis ejes con pesos.

| Eje | Herramientas |
|---|---|
| Performance | Lighthouse, CrUX (opcional) |
| SEO técnico | probe propio, lychee, xmllint |
| Seguridad | testssl.sh, headers vía curl |
| Accesibilidad | axe-core |
| Dependencias | retire.js (BB), osv-scanner + Syft (WB) |
| Agent-readiness | probe propio |

Agent-readiness no se combina en ningún compuesto; se reporta con su propio nivel, declarando explícitamente que su impacto no está probado (Google clasifica llms.txt como mito).

### 5.2 Modos

- **black-box**: solo URL pública. Detección de dependencias parcial por definición.
- **white-box**: con repo. Lockfiles, SBOM, deps deprecadas, calidad de código.
- **quick**: una URL, sin crawl, ~40–60s por eje.
- **deep**: muestreo de 5–10 páginas representativas. Habilita duplicados, links rotos, reciprocidad de hreflang, páginas huérfanas.

---

## 6. Contrato de datos

El **catálogo de hallazgos** (`references/findings-catalog.md`, v1.0.0) es la especificación normativa: ~70 IDs estables con severidad, fase e interpretación. Ver documento adjunto.

Puntos no negociables:

- Los IDs son un contrato. Publicado un ID, nunca cambia de significado. Si un check evoluciona, se crea uno nuevo y el viejo se marca `deprecated`.
- Cada hallazgo lleva `confidence` separado de `severity`. Los `low` se listan pero no penalizan el score.
- Un hallazgo repetido en N páginas es **uno** con `count: N`.
- Cada corrida registra en `meta.json` la versión del catálogo y de **cada herramienta, incluida la de Chrome**.
- Tres hallazgos existen solo para que el reporte no mienta: `A11Y-MANUAL-REVIEW-PENDING`, `DEPS-VERSION-UNDETERMINED`, `PERF-FIELD-UNAVAILABLE`. Van siempre que apliquen.

### Regla de override

Un hallazgo `critical` marcado *blocking* (10 en total, ver catálogo) fija el eje en **0** y sube a portada, sin promediar. Motivo: un promedio ponderado daría 71 y enterraría el único hallazgo que importaba (ej. `noindex` en producción).

---

## 7. Decisiones tomadas

| Decisión | Razón |
|---|---|
| Sin Docker en fases 0–2 | El único beneficio real era reproducibilidad, y se cubre con versiones fijadas. Chrome headless en contenedor añade fricción y las fuentes faltantes alteran el CLS medido. |
| Probes container-agnostic desde el inicio | Contenerizar después es un Dockerfile, no un rediseño. |
| Reproducibilidad por versiones pineadas (sin `^`) | Registradas en `meta.json`. Permite detectar cuándo una comparación deja de ser válida. |
| Catálogo antes que código | Es el contrato entre piezas; sin él cada probe inventa su formato. |
| El agente nunca lee JSON crudo | Un reporte de Lighthouse solo consume el contexto entero. |
| Ningún probe puede tumbar la corrida | Diagnóstico parcial sirve; corrida caída de 8 min, no. |
| CLI en repo propio | Se versiona, publica y usa en CI sin arrastrar la skill. |

**Disparadores para contenerizar** (cualquiera de los tres): entra la 2ª persona a correr diagnósticos · el pipeline pasa a CI · se entrega la primera comparación "antes/después" que respalde una factura.

---

## 8. Fases y criterios de aceptación

**Fase 0 — Esqueleto con datos falsos (2–3 días)**
Schema, orquestador, un probe stub con datos fijos, normalizador, reporte HTML.
*Aceptación:* se genera un `report.html` completo desde datos inventados. Valida el flujo entero sin depender de Chrome headless y habilita feedback de diseño el día 3.

**Fase 1 — Cuatro probes reales, black-box (1 semana)**
Performance, accesibilidad, seguridad, SEO rápido.
*Aceptación:* corre contra 3 sitios reales de clientes y el output aguanta revisión técnica manual.

**Fase 2 — Los difíciles (2 semanas)**
Dependencias black-box (descargar bundles JS a temp + retire.js), agent-readiness, crawl para SEO profundo.
*Aceptación:* tasa de falsos positivos aceptable tras calibración; `DEPS-VERSION-UNDETERMINED` se emite correctamente.

**Fase 3 — White-box + CI (1 semana)**
osv-scanner, SBOM con Syft, deps deprecadas, ESLint. Job de GitHub Actions con presupuestos que fallen el build.
*Aceptación:* un PR con una dependencia vulnerable falla el build.

**Fase 4 — Capa de juicio (1–2 semanas)**
Screenshots evaluados por el agente: calidad de alt text, contraste en hover/focus, orden de foco. Reporte ejecutivo.
*Aceptación:* el agente detecta al menos un problema real que axe no reportó.

### Hito obligatorio antes de exponer un score a un cliente

**Calibración contra 3 sitios conocidos**: uno sano, uno mediocre, uno malo. Si el sano saca 62 y el malo 58, la rúbrica está mal. De aquí salen los umbrales numéricos y los pesos finales — no se inventan antes.

---

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| Cloudflare / bot protection bloquea el scan | User-agent identificable (`FlareDiagnostics/1.0 (+contacto)`), respetar robots.txt siempre, throttling por host, pedir allowlist de IP antes de modo deep |
| Corrida supera ~6 min y la gente deja de usarla | Modo quick por defecto; deep es opt-in |
| Sitios detrás de login | Fuera de alcance hasta decidir el manejo de credenciales (conversación de seguridad, no técnica) |
| Falsos positivos erosionan la confianza | Campo `confidence`; los `low` no puntúan |
| Deriva de versión de Chrome altera métricas | Registrada en `meta.json`; detectable al comparar |
| Cliente lee el score como certificado de cumplimiento | Los tres hallazgos "no pudimos ver" + disclaimer en portada |

---

## 10. Abierto

1. Umbrales numéricos exactos (TTFB, tamaño de bundle, profundidad de clic) → siguen abiertos, salen de la calibración contra sitios reales (tickets #8 y #12 en GitHub).
2. ~~Pesos finales por eje~~ — **Resuelto (2026-09-06):** no hay pesos ni score agregado entre ejes; ver §5.1.
3. ~~Revisión de los hallazgos *blocking*~~ — **Resuelto:** `A11Y-FORM-LABEL-MISSING` baja a `high` (ya no es *blocking*); quedan 10 hallazgos *blocking* (ver catálogo §4). El resto no se objetó.
4. ~~Deduplicación entre ejes~~ — **Resuelto:** eje dueño único por hallazgo compartido (`DEPS-SOURCEMAP-EXPOSED` → DEPS; landmarks → A11Y); el otro eje lo menciona informativamente sin restar ahí.
5. ~~Qué hacer con `confidence: low`~~ — **Resuelto:** se listan aparte en el reporte de cliente, nunca se ocultan.
