# Catálogo de hallazgos — Diagnóstico técnico automatizado

**Versión del catálogo:** 1.0.0
**Regla de oro:** los IDs son un contrato. Una vez publicado un ID, nunca cambia de significado. Si un check evoluciona, se crea un ID nuevo y el viejo se marca `deprecated`. Sin esto se pierde la comparabilidad histórica, que es el activo del sistema.

---

## 1. Convención de IDs

```
<EJE>-<OBJETO>-<PROBLEMA>
```

- `EJE`: PERF, A11Y, SEO, DEPS, SEC, AGENT
- `OBJETO`: sobre qué recae el hallazgo (CANONICAL, LCP, PKG, HEADER…)
- `PROBLEMA`: qué está mal (MISSING, INVALID, CHAIN, OUTDATED…)

Mayúsculas, guiones, sin números correlativos. `SEO-CANONICAL-CHAIN` se lee solo; `SEO-014` no.

---

## 2. Esquema del objeto hallazgo

```json
{
  "id": "SEO-CANONICAL-CONFLICT",
  "catalog_version": "1.0.0",
  "severity": "critical",
  "confidence": "high",
  "title": "El canonical apunta a una URL con noindex",
  "affected": ["https://cliente.com/producto/x"],
  "count": 1,
  "evidence": {
    "canonical_target": "https://cliente.com/producto/",
    "target_meta_robots": "noindex,follow"
  },
  "source": "probe:seo",
  "tool": "internal",
  "mode": "quick",
  "remediation": "Apuntar el canonical a una URL indexable, o quitar el noindex del destino.",
  "doc_ref": "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls"
}
```

**Campos que importan y por qué:**

- `confidence` (`high` | `medium` | `low`): separa "esto es un hecho" de "esto probablemente sea un problema". Los hallazgos `low` no penalizan el score, solo se listan. Es la válvula contra falsos positivos, especialmente en DEPS black-box y en accesibilidad.
- `count` + `affected`: un hallazgo que aparece en 200 páginas es uno solo con `count: 200`, no 200 hallazgos. Sin esto, el reporte se vuelve ilegible y el score se distorsiona.
- `mode` (`quick` | `deep` | `whitebox`): permite filtrar qué se pudo evaluar en esta corrida.
- `tool`: qué herramienta lo detectó. Necesario para depurar y para saber qué se rompe cuando una herramienta cambia de versión.

---

## 3. Severidades

| Nivel | Criterio | Efecto en el score |
|---|---|---|
| `critical` | Rompe la función. El sitio no se indexa, no se puede usar con teclado, hay una CVE explotada activamente. | Fija el eje en 0 (ver regla de override) |
| `high` | Degrada seriamente. Métrica fuera de umbral, vulnerabilidad sin exploit conocido, hreflang roto. | −15 pts |
| `medium` | Degrada de forma acotada o afecta a la presentación. | −5 pts |
| `low` | Higiene, buenas prácticas, oportunidades. | −1 pt |
| `info` | Contexto, no es un problema. | 0 |

**Regla de override:** un hallazgo `critical` de una categoría marcada `blocking` fija el eje en 0 y sube a portada del reporte, sin promediar. Los blocking están marcados con 🚫 abajo. Motivo: un promedio ponderado daría 71 y enterraría el único hallazgo que importaba.

---

## 4. Catálogo

`M` = va en el MVP (Fase 1). `2` = Fase 2. `3` = Fase 3 (white-box / CI). `4` = Fase 4 (juicio del agente).

### PERF — Performance

| ID | Fase | Sev. base | Qué detecta |
|---|---|---|---|
| `PERF-LCP-POOR` | M | high | LCP por encima de 2.5s (lab) o fuera del umbral bueno en campo |
| `PERF-CLS-POOR` | M | high | CLS por encima de 0.1 |
| `PERF-TBT-HIGH` | M | medium | TBT alto (proxy de INP; no es INP, hay que decirlo en el reporte) |
| `PERF-TTFB-SLOW` | M | medium | TTFB por encima de 800ms |
| `PERF-FIELD-UNAVAILABLE` | M | info | Sin datos de campo en CrUX: el origen no tiene tráfico suficiente |
| `PERF-IMG-UNOPTIMIZED` | M | medium | Imágenes sin formato moderno, sin dimensionar o sobredimensionadas |
| `PERF-RENDER-BLOCKING` | M | medium | CSS/JS bloqueando el render |
| `PERF-JS-UNUSED` | 2 | medium | Porcentaje alto de JS no utilizado |
| `PERF-BUNDLE-OVERSIZED` | 2 | high | Bundle principal por encima del presupuesto definido |
| `PERF-NO-CACHE-POLICY` | M | medium | Estáticos sin cache-control de larga duración |
| `PERF-LAB-VARIANCE-HIGH` | 2 | info | Varianza alta entre corridas: la medición no es confiable, hay que repetir |

### A11Y — Accesibilidad

| ID | Fase | Sev. base | Qué detecta |
|---|---|---|---|
| `A11Y-CONTRAST-INSUFFICIENT` | M | high | Contraste por debajo de WCAG AA |
| `A11Y-IMG-ALT-MISSING` | M | high | Imágenes sin atributo alt |
| `A11Y-FORM-LABEL-MISSING` | M | critical 🚫 | Campos de formulario sin etiqueta accesible |
| `A11Y-BUTTON-NAME-MISSING` | M | critical 🚫 | Botones o enlaces sin nombre accesible |
| `A11Y-LANG-MISSING` | M | medium | `<html>` sin atributo lang o con valor inválido |
| `A11Y-HEADING-ORDER` | M | medium | Saltos en la jerarquía de encabezados |
| `A11Y-LANDMARKS-MISSING` | M | medium | Sin landmarks o regiones (compartido con AGENT) |
| `A11Y-ARIA-INVALID` | M | high | Roles o atributos ARIA mal usados |
| `A11Y-KEYBOARD-TRAP` | 4 | critical 🚫 | Foco que no se puede sacar con teclado |
| `A11Y-FOCUS-NOT-VISIBLE` | 4 | high | Indicador de foco ausente o invisible |
| `A11Y-FOCUS-ORDER-ILLOGICAL` | 4 | high | Orden de tabulación no sigue el orden visual |
| `A11Y-ALT-NOT-DESCRIPTIVE` | 4 | medium | Alt presente pero inútil ("imagen", "foto1.jpg") — juicio del agente |
| `A11Y-MANUAL-REVIEW-PENDING` | M | info | Marca explícita del ~43% de criterios WCAG que axe no puede evaluar |

> `A11Y-MANUAL-REVIEW-PENDING` no es relleno: es lo que impide que el reporte se lea como un certificado de cumplimiento. Va siempre, en todas las corridas.

### SEO — SEO técnico

| ID | Fase | Sev. base | Qué detecta |
|---|---|---|---|
| `SEO-NOINDEX-UNINTENDED` | M | critical 🚫 | noindex en producción vía meta o X-Robots-Tag |
| `SEO-ROBOTS-BLOCKS-ALL` | M | critical 🚫 | robots.txt bloqueando el sitio entero |
| `SEO-ROBOTS-INVALID` | M | high | robots.txt con sintaxis inválida |
| `SEO-ROBOTS-BLOCKS-ASSETS` | M | medium | CSS/JS bloqueados: Google no puede renderizar |
| `SEO-STATUS-ERROR` | M | critical 🚫 | La URL devuelve 4xx o 5xx |
| `SEO-REDIRECT-CHAIN` | M | medium | Cadena de más de un salto |
| `SEO-REDIRECT-LOOP` | M | critical 🚫 | Bucle de redirección |
| `SEO-CANONICAL-MISSING` | M | medium | Sin rel=canonical |
| `SEO-CANONICAL-CONFLICT` | M | critical 🚫 | Canonical hacia una URL con noindex, 404 o redirigida |
| `SEO-CANONICAL-CHAIN` | 2 | high | Canonical apuntando a una página que a su vez canonicaliza a otra |
| `SEO-SITEMAP-MISSING` | M | medium | Sin sitemap.xml o no declarado en robots.txt |
| `SEO-SITEMAP-INVALID` | M | high | No valida contra el esquema de sitemaps.org |
| `SEO-SITEMAP-LIMITS-EXCEEDED` | M | high | Más de 50.000 URLs o 50MB sin usar índice |
| `SEO-SITEMAP-DIRTY-URLS` | 2 | high | URLs con noindex, redirigidas o rotas dentro del sitemap |
| `SEO-TITLE-MISSING` | M | high | Sin title |
| `SEO-TITLE-DUPLICATE` | 2 | medium | Title repetido entre páginas |
| `SEO-META-DESC-MISSING` | M | low | Sin meta description |
| `SEO-META-DESC-DUPLICATE` | 2 | low | Meta description repetida |
| `SEO-H1-MISSING` | M | medium | Sin H1 o con varios |
| `SEO-HREFLANG-INVALID` | M | high | Códigos ISO mal formados o x-default ausente |
| `SEO-HREFLANG-NO-RETURN` | 2 | high | Falta reciprocidad entre versiones de idioma |
| `SEO-HREFLANG-CANONICAL-CONFLICT` | M | high | hreflang y canonical dándose instrucciones contradictorias |
| `SEO-JSONLD-INVALID` | M | medium | JSON-LD que no parsea o sin @type / @context |
| `SEO-JSONLD-INCOMPLETE` | M | low | Faltan campos requeridos para rich results del tipo declarado |
| `SEO-CSR-CONTENT-INVISIBLE` | M | high | El contenido solo existe tras ejecutar JS |
| `SEO-LINKS-NOT-CRAWLABLE` | M | high | Navegación sin `<a href>` reales (incluye paginación solo por JS) |
| `SEO-LINKS-BROKEN` | 2 | medium | Enlaces internos o externos rotos |
| `SEO-MIXED-CONTENT` | M | high | Recursos http en página https |
| `SEO-VIEWPORT-MISSING` | M | high | Sin meta viewport |
| `SEO-ORPHAN-PAGES` | 2 | medium | Páginas en el sitemap sin enlaces entrantes |
| `SEO-CONTENT-NEAR-DUPLICATE` | 2 | medium | Páginas con contenido casi idéntico (simhash) |

**No existen en este catálogo, a propósito:** ausencia de `rel=next/prev` (deprecado por Google en 2019), meta keywords, densidad de palabra clave, longitud mínima de contenido, "penalización por contenido duplicado". Si alguien los pide, la respuesta está en `references/seo-folclore.md`.

### DEPS — Dependencias y vulnerabilidades

| ID | Fase | Sev. base | Qué detecta |
|---|---|---|---|
| `DEPS-VULN-KEV` | 2 | critical 🚫 | Vulnerabilidad en el catálogo CISA KEV (explotada activamente) |
| `DEPS-VULN-CRITICAL` | 2 | critical | CVSS ≥ 9.0 |
| `DEPS-VULN-HIGH` | 2 | high | CVSS 7.0–8.9 |
| `DEPS-VULN-MEDIUM` | 2 | medium | CVSS 4.0–6.9 |
| `DEPS-VULN-HIGH-EPSS` | 2 | high | EPSS alto aunque el CVSS sea moderado |
| `DEPS-LIB-OUTDATED` | 2 | medium | Librería con versión mayor de retraso |
| `DEPS-LIB-DEPRECATED` | 3 | high | Paquete marcado como deprecated en npm |
| `DEPS-LIB-UNMAINTAINED` | 3 | medium | Sin publicaciones ni actividad en el repo (OpenSSF Scorecard) |
| `DEPS-RUNTIME-EOL` | 3 | high | Runtime o framework fuera de soporte (endoflife.date) |
| `DEPS-SOURCEMAP-EXPOSED` | 2 | medium | Sourcemaps públicos en producción (también es hallazgo de SEC) |
| `DEPS-VERSION-UNDETERMINED` | 2 | info | Se detectó la librería pero no la versión: el análisis black-box es parcial |

> `DEPS-VERSION-UNDETERMINED` es obligatorio en modo black-box. Es lo que evita que el cliente lea "0 vulnerabilidades" como "está limpio" cuando en realidad significa "no pudimos ver".

### SEC — Seguridad

| ID | Fase | Sev. base | Qué detecta |
|---|---|---|---|
| `SEC-CSP-MISSING` | M | high | Sin Content-Security-Policy |
| `SEC-CSP-UNSAFE` | M | medium | CSP con unsafe-inline o unsafe-eval |
| `SEC-HSTS-MISSING` | M | medium | Sin Strict-Transport-Security |
| `SEC-XFO-MISSING` | M | medium | Sin protección contra clickjacking |
| `SEC-TLS-WEAK` | M | high | Protocolos o cifrados obsoletos |
| `SEC-TLS-EXPIRING` | M | high | Certificado por vencer en menos de 30 días |
| `SEC-TLS-EXPIRED` | M | critical 🚫 | Certificado vencido |
| `SEC-COOKIE-INSECURE` | M | medium | Cookies sin Secure, HttpOnly o SameSite |
| `SEC-SERVER-VERSION-DISCLOSED` | M | low | Headers revelando versión de servidor o framework |
| `SEC-COOKIES-PRE-CONSENT` | 2 | medium | Cookies de tracking antes del consentimiento |

### AGENT — Preparación para agentes

Peso bajo en el score global (5–10%) por impacto no probado. El reporte debe decirlo explícitamente.

| ID | Fase | Sev. base | Qué detecta |
|---|---|---|---|
| `AGENT-NO-JS-CONTENT-EMPTY` | 2 | high | Sin JS, la página no entrega contenido |
| `AGENT-AI-BOTS-BLOCKED` | 2 | info | robots.txt bloquea GPTBot / ClaudeBot / PerplexityBot — hallazgo neutral: puede ser intencional |
| `AGENT-STRUCTURED-DATA-MISSING` | 2 | low | Sin JSON-LD que declare entidades |
| `AGENT-LLMSTXT-MISSING` | 2 | low | Sin llms.txt — higiene, no factor probado |
| `AGENT-WELLKNOWN-MISSING` | 2 | low | Sin endpoints en /.well-known/ |
| `AGENT-SEMANTICS-POOR` | 2 | medium | Sin landmarks ni nombres accesibles: un agente no puede operar el sitio |

> `AGENT-AI-BOTS-BLOCKED` se reporta como `info`, nunca como problema. Bloquear crawlers de IA es una decisión de negocio legítima y no nos toca opinar sin contexto.

---

## 5. Lo que falta decidir

1. **Umbrales exactos** de cada check numérico (TTFB, tamaño de bundle, profundidad de clic). Salen de la calibración contra los tres sitios de referencia, no de inventarlos ahora.
2. **Pesos finales** por eje. Propuesta de partida: PERF 20 / SEO 20 / SEC 20 / A11Y 18 / DEPS 17 / AGENT 5.
3. **Qué hacer con `confidence: low`**: listarlos aparte o esconderlos por defecto en el reporte de cliente.
4. **Deduplicación entre ejes**: `DEPS-SOURCEMAP-EXPOSED` y los landmarks aparecen en dos ejes. Decidir si se cuentan dos veces en el score o se asigna un eje dueño.
