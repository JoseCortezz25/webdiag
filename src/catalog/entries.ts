/**
 * The finding catalogue, v1.0.0.
 *
 * Transcribed from `docs/inbox/findings-catalog.md` §4, which is the normative
 * source (spec §6). The `detects` strings are kept verbatim in Spanish on
 * purpose: they are the published meaning of each ID, and paraphrasing them
 * would silently redefine the contract this module exists to protect.
 *
 * Adding a row is additive and safe. Editing the meaning of an existing row is
 * not: `contract-lock.test.ts` fails on it. Retire the old ID instead.
 */
import { defineEntry } from './entry.ts';

export const CATALOG_ENTRIES = [
  // PERF — Performance
  defineEntry({
    id: 'PERF-LCP-POOR',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'LCP por encima de 2.5s (lab) o fuera del umbral bueno en campo',
  }),
  defineEntry({
    id: 'PERF-CLS-POOR',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'CLS por encima de 0.1',
  }),
  defineEntry({
    id: 'PERF-TBT-HIGH',
    phase: 'M',
    baseSeverity: 'medium',
    detects: 'TBT alto (proxy de INP; no es INP, hay que decirlo en el reporte)',
  }),
  defineEntry({
    id: 'PERF-TTFB-SLOW',
    phase: 'M',
    baseSeverity: 'medium',
    detects: 'TTFB por encima de 800ms',
  }),
  defineEntry({
    id: 'PERF-FIELD-UNAVAILABLE',
    phase: 'M',
    baseSeverity: 'info',
    alwaysEmitted: true,
    detects: 'Sin datos de campo en CrUX: el origen no tiene tráfico suficiente',
    note: 'Uno de los tres hallazgos que existen para que el reporte no mienta sobre lo que no se pudo medir.',
  }),
  defineEntry({
    id: 'PERF-IMG-UNOPTIMIZED',
    phase: 'M',
    baseSeverity: 'medium',
    detects: 'Imágenes sin formato moderno, sin dimensionar o sobredimensionadas',
  }),
  defineEntry({
    id: 'PERF-RENDER-BLOCKING',
    phase: 'M',
    baseSeverity: 'medium',
    detects: 'CSS/JS bloqueando el render',
  }),
  defineEntry({
    id: 'PERF-JS-UNUSED',
    phase: '2',
    baseSeverity: 'medium',
    detects: 'Porcentaje alto de JS no utilizado',
  }),
  defineEntry({
    id: 'PERF-BUNDLE-OVERSIZED',
    phase: '2',
    baseSeverity: 'high',
    detects: 'Bundle principal por encima del presupuesto definido',
  }),
  defineEntry({
    id: 'PERF-NO-CACHE-POLICY',
    phase: 'M',
    baseSeverity: 'medium',
    detects: 'Estáticos sin cache-control de larga duración',
  }),
  defineEntry({
    id: 'PERF-LAB-VARIANCE-HIGH',
    phase: '2',
    baseSeverity: 'info',
    detects: 'Varianza alta entre corridas: la medición no es confiable, hay que repetir',
  }),

  // A11Y — Accesibilidad
  defineEntry({
    id: 'A11Y-CONTRAST-INSUFFICIENT',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'Contraste por debajo de WCAG AA',
  }),
  defineEntry({
    id: 'A11Y-IMG-ALT-MISSING',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'Imágenes sin atributo alt',
  }),
  defineEntry({
    id: 'A11Y-FORM-LABEL-MISSING',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'Campos de formulario sin etiqueta accesible',
    note: 'Reclasificado de critical/blocking a high el 2026-09-06 (spec §10.3). No fija el eje en 0.',
  }),
  defineEntry({
    id: 'A11Y-BUTTON-NAME-MISSING',
    phase: 'M',
    baseSeverity: 'critical',
    blocking: true,
    detects: 'Botones o enlaces sin nombre accesible',
  }),
  defineEntry({
    id: 'A11Y-LANG-MISSING',
    phase: 'M',
    baseSeverity: 'medium',
    detects: '`<html>` sin atributo lang o con valor inválido',
  }),
  defineEntry({
    id: 'A11Y-HEADING-ORDER',
    phase: 'M',
    baseSeverity: 'medium',
    detects: 'Saltos en la jerarquía de encabezados',
  }),
  defineEntry({
    id: 'A11Y-LANDMARKS-MISSING',
    phase: 'M',
    baseSeverity: 'medium',
    mentionedIn: ['AGENT'],
    detects: 'Sin landmarks o regiones',
    note: 'Eje dueño A11Y. AGENT lo menciona informativamente y no vuelve a restar por eso.',
  }),
  defineEntry({
    id: 'A11Y-ARIA-INVALID',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'Roles o atributos ARIA mal usados',
  }),
  defineEntry({
    id: 'A11Y-KEYBOARD-TRAP',
    phase: '4',
    baseSeverity: 'critical',
    blocking: true,
    detects: 'Foco que no se puede sacar con teclado',
  }),
  defineEntry({
    id: 'A11Y-FOCUS-NOT-VISIBLE',
    phase: '4',
    baseSeverity: 'high',
    detects: 'Indicador de foco ausente o invisible',
  }),
  defineEntry({
    id: 'A11Y-FOCUS-ORDER-ILLOGICAL',
    phase: '4',
    baseSeverity: 'high',
    detects: 'Orden de tabulación no sigue el orden visual',
  }),
  defineEntry({
    id: 'A11Y-ALT-NOT-DESCRIPTIVE',
    phase: '4',
    baseSeverity: 'medium',
    detects: 'Alt presente pero inútil ("imagen", "foto1.jpg") — juicio del agente',
  }),
  defineEntry({
    id: 'A11Y-MANUAL-REVIEW-PENDING',
    phase: 'M',
    baseSeverity: 'info',
    alwaysEmitted: true,
    detects: 'Marca explícita del ~43% de criterios WCAG que axe no puede evaluar',
    note: 'Va siempre, en todas las corridas: es lo que impide que el reporte se lea como un certificado de cumplimiento.',
  }),

  // SEO — SEO técnico
  defineEntry({
    id: 'SEO-NOINDEX-UNINTENDED',
    phase: 'M',
    baseSeverity: 'critical',
    blocking: true,
    detects: 'noindex en producción vía meta o X-Robots-Tag',
  }),
  defineEntry({
    id: 'SEO-ROBOTS-BLOCKS-ALL',
    phase: 'M',
    baseSeverity: 'critical',
    blocking: true,
    detects: 'robots.txt bloqueando el sitio entero',
  }),
  defineEntry({
    id: 'SEO-ROBOTS-INVALID',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'robots.txt con sintaxis inválida',
  }),
  defineEntry({
    id: 'SEO-ROBOTS-BLOCKS-ASSETS',
    phase: 'M',
    baseSeverity: 'medium',
    detects: 'CSS/JS bloqueados: Google no puede renderizar',
  }),
  defineEntry({
    id: 'SEO-STATUS-ERROR',
    phase: 'M',
    baseSeverity: 'critical',
    blocking: true,
    detects: 'La URL devuelve 4xx o 5xx',
  }),
  defineEntry({
    id: 'SEO-REDIRECT-CHAIN',
    phase: 'M',
    baseSeverity: 'medium',
    detects: 'Cadena de más de un salto',
  }),
  defineEntry({
    id: 'SEO-REDIRECT-LOOP',
    phase: 'M',
    baseSeverity: 'critical',
    blocking: true,
    detects: 'Bucle de redirección',
  }),
  defineEntry({
    id: 'SEO-CANONICAL-MISSING',
    phase: 'M',
    baseSeverity: 'medium',
    detects: 'Sin rel=canonical',
  }),
  defineEntry({
    id: 'SEO-CANONICAL-CONFLICT',
    phase: 'M',
    baseSeverity: 'critical',
    blocking: true,
    detects: 'Canonical hacia una URL con noindex, 404 o redirigida',
  }),
  defineEntry({
    id: 'SEO-CANONICAL-CHAIN',
    phase: '2',
    baseSeverity: 'high',
    detects: 'Canonical apuntando a una página que a su vez canonicaliza a otra',
  }),
  defineEntry({
    id: 'SEO-SITEMAP-MISSING',
    phase: 'M',
    baseSeverity: 'medium',
    detects: 'Sin sitemap.xml o no declarado en robots.txt',
  }),
  defineEntry({
    id: 'SEO-SITEMAP-INVALID',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'No valida contra el esquema de sitemaps.org',
  }),
  defineEntry({
    id: 'SEO-SITEMAP-LIMITS-EXCEEDED',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'Más de 50.000 URLs o 50MB sin usar índice',
  }),
  defineEntry({
    id: 'SEO-SITEMAP-DIRTY-URLS',
    phase: '2',
    baseSeverity: 'high',
    detects: 'URLs con noindex, redirigidas o rotas dentro del sitemap',
  }),
  defineEntry({
    id: 'SEO-TITLE-MISSING',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'Sin title',
  }),
  defineEntry({
    id: 'SEO-TITLE-DUPLICATE',
    phase: '2',
    baseSeverity: 'medium',
    detects: 'Title repetido entre páginas',
  }),
  defineEntry({
    id: 'SEO-META-DESC-MISSING',
    phase: 'M',
    baseSeverity: 'low',
    detects: 'Sin meta description',
  }),
  defineEntry({
    id: 'SEO-META-DESC-DUPLICATE',
    phase: '2',
    baseSeverity: 'low',
    detects: 'Meta description repetida',
  }),
  defineEntry({
    id: 'SEO-H1-MISSING',
    phase: 'M',
    baseSeverity: 'medium',
    detects: 'Sin H1 o con varios',
  }),
  defineEntry({
    id: 'SEO-HREFLANG-INVALID',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'Códigos ISO mal formados o x-default ausente',
  }),
  defineEntry({
    id: 'SEO-HREFLANG-NO-RETURN',
    phase: '2',
    baseSeverity: 'high',
    detects: 'Falta reciprocidad entre versiones de idioma',
  }),
  defineEntry({
    id: 'SEO-HREFLANG-CANONICAL-CONFLICT',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'hreflang y canonical dándose instrucciones contradictorias',
  }),
  defineEntry({
    id: 'SEO-JSONLD-INVALID',
    phase: 'M',
    baseSeverity: 'medium',
    detects: 'JSON-LD que no parsea o sin @type / @context',
  }),
  defineEntry({
    id: 'SEO-JSONLD-INCOMPLETE',
    phase: 'M',
    baseSeverity: 'low',
    detects: 'Faltan campos requeridos para rich results del tipo declarado',
  }),
  defineEntry({
    id: 'SEO-CSR-CONTENT-INVISIBLE',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'El contenido solo existe tras ejecutar JS',
  }),
  defineEntry({
    id: 'SEO-LINKS-NOT-CRAWLABLE',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'Navegación sin `<a href>` reales (incluye paginación solo por JS)',
  }),
  defineEntry({
    id: 'SEO-LINKS-BROKEN',
    phase: '2',
    baseSeverity: 'medium',
    detects: 'Enlaces internos o externos rotos',
  }),
  defineEntry({
    id: 'SEO-MIXED-CONTENT',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'Recursos http en página https',
  }),
  defineEntry({
    id: 'SEO-VIEWPORT-MISSING',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'Sin meta viewport',
  }),
  defineEntry({
    id: 'SEO-ORPHAN-PAGES',
    phase: '2',
    baseSeverity: 'medium',
    detects: 'Páginas en el sitemap sin enlaces entrantes',
  }),
  defineEntry({
    id: 'SEO-CONTENT-NEAR-DUPLICATE',
    phase: '2',
    baseSeverity: 'medium',
    detects: 'Páginas con contenido casi idéntico (simhash)',
  }),

  // DEPS — Dependencias y vulnerabilidades
  defineEntry({
    id: 'DEPS-VULN-KEV',
    phase: '2',
    baseSeverity: 'critical',
    blocking: true,
    detects: 'Vulnerabilidad en el catálogo CISA KEV (explotada activamente)',
  }),
  defineEntry({
    id: 'DEPS-VULN-CRITICAL',
    phase: '2',
    baseSeverity: 'critical',
    detects: 'CVSS ≥ 9.0',
    note: 'Critical sin marca 🚫: fija el eje en 0 como cualquier critical, pero no sube a portada.',
  }),
  defineEntry({
    id: 'DEPS-VULN-HIGH',
    phase: '2',
    baseSeverity: 'high',
    detects: 'CVSS 7.0–8.9',
  }),
  defineEntry({
    id: 'DEPS-VULN-MEDIUM',
    phase: '2',
    baseSeverity: 'medium',
    detects: 'CVSS 4.0–6.9',
  }),
  defineEntry({
    id: 'DEPS-VULN-HIGH-EPSS',
    phase: '2',
    baseSeverity: 'high',
    detects: 'EPSS alto aunque el CVSS sea moderado',
  }),
  defineEntry({
    id: 'DEPS-LIB-OUTDATED',
    phase: '2',
    baseSeverity: 'medium',
    detects: 'Librería con versión mayor de retraso',
  }),
  defineEntry({
    id: 'DEPS-LIB-DEPRECATED',
    phase: '3',
    baseSeverity: 'high',
    detects: 'Paquete marcado como deprecated en npm',
  }),
  defineEntry({
    id: 'DEPS-LIB-UNMAINTAINED',
    phase: '3',
    baseSeverity: 'medium',
    detects: 'Sin publicaciones ni actividad en el repo (OpenSSF Scorecard)',
  }),
  defineEntry({
    id: 'DEPS-RUNTIME-EOL',
    phase: '3',
    baseSeverity: 'high',
    detects: 'Runtime o framework fuera de soporte (endoflife.date)',
  }),
  defineEntry({
    id: 'DEPS-SOURCEMAP-EXPOSED',
    phase: '2',
    baseSeverity: 'medium',
    mentionedIn: ['SEC'],
    detects: 'Sourcemaps públicos en producción',
    note: 'Eje dueño DEPS. SEC lo menciona informativamente y no resta ahí.',
  }),
  defineEntry({
    id: 'DEPS-VERSION-UNDETERMINED',
    phase: '2',
    baseSeverity: 'info',
    alwaysEmitted: true,
    detects: 'Se detectó la librería pero no la versión: el análisis black-box es parcial',
    note: 'Obligatorio en modo black-box: evita que "0 vulnerabilidades" se lea como "está limpio".',
  }),

  // SEC — Seguridad
  defineEntry({
    id: 'SEC-CSP-MISSING',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'Sin Content-Security-Policy',
  }),
  defineEntry({
    id: 'SEC-CSP-UNSAFE',
    phase: 'M',
    baseSeverity: 'medium',
    detects: 'CSP con unsafe-inline o unsafe-eval',
  }),
  defineEntry({
    id: 'SEC-HSTS-MISSING',
    phase: 'M',
    baseSeverity: 'medium',
    detects: 'Sin Strict-Transport-Security',
  }),
  defineEntry({
    id: 'SEC-XFO-MISSING',
    phase: 'M',
    baseSeverity: 'medium',
    detects: 'Sin protección contra clickjacking',
  }),
  defineEntry({
    id: 'SEC-TLS-WEAK',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'Protocolos o cifrados obsoletos',
  }),
  defineEntry({
    id: 'SEC-TLS-EXPIRING',
    phase: 'M',
    baseSeverity: 'high',
    detects: 'Certificado por vencer en menos de 30 días',
  }),
  defineEntry({
    id: 'SEC-TLS-EXPIRED',
    phase: 'M',
    baseSeverity: 'critical',
    blocking: true,
    detects: 'Certificado vencido',
  }),
  defineEntry({
    id: 'SEC-COOKIE-INSECURE',
    phase: 'M',
    baseSeverity: 'medium',
    detects: 'Cookies sin Secure, HttpOnly o SameSite',
  }),
  defineEntry({
    id: 'SEC-SERVER-VERSION-DISCLOSED',
    phase: 'M',
    baseSeverity: 'low',
    detects: 'Headers revelando versión de servidor o framework',
  }),
  defineEntry({
    id: 'SEC-COOKIES-PRE-CONSENT',
    phase: '2',
    baseSeverity: 'medium',
    detects: 'Cookies de tracking antes del consentimiento',
  }),

  // AGENT — Preparación para agentes
  defineEntry({
    id: 'AGENT-NO-JS-CONTENT-EMPTY',
    phase: '2',
    baseSeverity: 'high',
    detects: 'Sin JS, la página no entrega contenido',
  }),
  defineEntry({
    id: 'AGENT-AI-BOTS-BLOCKED',
    phase: '2',
    baseSeverity: 'info',
    detects:
      'robots.txt bloquea GPTBot / ClaudeBot / PerplexityBot — hallazgo neutral: puede ser intencional',
    note: 'Se reporta como info, nunca como problema: bloquear crawlers de IA es una decisión de negocio legítima.',
  }),
  defineEntry({
    id: 'AGENT-STRUCTURED-DATA-MISSING',
    phase: '2',
    baseSeverity: 'low',
    detects: 'Sin JSON-LD que declare entidades',
  }),
  defineEntry({
    id: 'AGENT-LLMSTXT-MISSING',
    phase: '2',
    baseSeverity: 'low',
    detects: 'Sin llms.txt — higiene, no factor probado',
  }),
  defineEntry({
    id: 'AGENT-WELLKNOWN-MISSING',
    phase: '2',
    baseSeverity: 'low',
    detects: 'Sin endpoints en /.well-known/',
  }),
  defineEntry({
    id: 'AGENT-SEMANTICS-POOR',
    phase: '2',
    baseSeverity: 'medium',
    detects: 'Sin landmarks ni nombres accesibles: un agente no puede operar el sitio',
    note: 'Si el único motivo es la ausencia de landmarks, ese punto ya lo puntuó A11Y-LANDMARKS-MISSING y aquí no se resta de nuevo.',
  }),
] as const;
