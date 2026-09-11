/**
 * The phase 0 probe: fixed data, no network, no external tool.
 *
 * Its whole job is to prove the pipeline (spec §8, phase 0): "se genera un
 * `report.html` completo desde datos inventados". Every observation below is
 * invented, and it is chosen to exercise a rule the normalizer or the report
 * would otherwise never hit until real probes land:
 *
 *  - `SEO-NOINDEX-UNINTENDED` is a *blocking* critical, so it zeroes SEO and
 *    lands on the cover instead of averaging away.
 *  - `A11Y-CONTRAST-INSUFFICIENT` appears twice, so the merge into one finding
 *    with `count: 7` is exercised end to end rather than only in a unit test.
 *  - `DEPS-VULN-HIGH` is `confidence: low`, so the report must list it and the
 *    score must ignore it.
 *  - `A11Y-LANDMARKS-MISSING` and `DEPS-SOURCEMAP-EXPOSED` are the two shared
 *    findings, so the "mentioned in another axis without deducting" path runs.
 *  - The three always-emitted "we could not see this" findings are present, so
 *    the report cannot be read as a certificate of compliance.
 *
 * The fixture is a module-level constant and is copied on read, so two runs in
 * the same process cannot observe each other. That is the determinism criterion
 * of the ticket, enforced by construction rather than by discipline.
 */
import type { Axis, Mode } from '../catalog/index.ts';
import { AXES } from '../catalog/index.ts';
import type { PerfDetail } from './perf/detail.ts';
import type { Probe, ProbeContext } from './probe.ts';
import {
  RAW_SCHEMA_VERSION,
  type RawDocument,
  type RawObservation,
  type ToolVersion,
} from './raw.ts';

export const STUB_TOOL: ToolVersion = {
  name: 'webdiag-stub',
  version: '0.0.0-fixture',
};

/**
 * An observation plus the modes it is visible in. A `deep` run samples several
 * pages, so it can see things a single-URL `quick` run cannot; without this the
 * stub would claim a crawl found exactly what no crawl found.
 */
type StubObservation = RawObservation & {
  readonly modes: readonly Mode[];
};

const ALL_MODES: readonly Mode[] = ['quick', 'deep', 'whitebox'];
const DEEP_ONLY: readonly Mode[] = ['deep'];

const FIXTURE: Readonly<Record<Axis, readonly StubObservation[]>> = {
  PERF: [
    {
      id: 'PERF-LCP-POOR',
      modes: ALL_MODES,
      confidence: 'high',
      count: 1,
      affected: ['/'],
      evidence: { lcp_ms: 4120, threshold_ms: 2500, element: 'img.hero' },
      remediation: 'Precargar la imagen LCP y servirla en AVIF/WebP dimensionada al viewport.',
      title: 'El contenido principal tarda 4.1s en aparecer',
    },
    {
      id: 'PERF-TBT-HIGH',
      modes: ALL_MODES,
      confidence: 'medium',
      count: 1,
      affected: ['/'],
      evidence: { tbt_ms: 890, threshold_ms: 200, note: 'proxy de INP, no es INP' },
      remediation: 'Dividir el bundle principal y diferir el JS de terceros.',
    },
    {
      id: 'PERF-IMG-UNOPTIMIZED',
      modes: ALL_MODES,
      confidence: 'high',
      count: 12,
      affected: ['/', '/servicios', '/contacto'],
      evidence: { images: 12, wasted_kb: 1840, formats: ['jpeg', 'png'] },
      remediation: 'Convertir a AVIF/WebP y declarar width/height en cada imagen.',
    },
    {
      id: 'PERF-FIELD-UNAVAILABLE',
      modes: ALL_MODES,
      confidence: 'high',
      count: 1,
      affected: ['/'],
      evidence: { source: 'CrUX', reason: 'origen sin trafico suficiente' },
      remediation:
        'Ninguna: es una limitacion de la medicion. Los numeros de este eje son de laboratorio.',
    },
  ],
  A11Y: [
    {
      id: 'A11Y-CONTRAST-INSUFFICIENT',
      modes: ALL_MODES,
      confidence: 'high',
      count: 4,
      affected: ['/'],
      evidence: { ratio: 2.8, required: 4.5, selector: '.nav a' },
      remediation: 'Subir el contraste del texto de navegacion a 4.5:1 como minimo.',
    },
    {
      id: 'A11Y-CONTRAST-INSUFFICIENT',
      modes: ALL_MODES,
      confidence: 'high',
      count: 3,
      affected: ['/contacto'],
      evidence: { ratio: 3.1, required: 4.5, selector: '.form label' },
      remediation: 'Subir el contraste del texto de navegacion a 4.5:1 como minimo.',
    },
    {
      id: 'A11Y-IMG-ALT-MISSING',
      modes: ALL_MODES,
      confidence: 'high',
      count: 5,
      affected: ['/', '/servicios'],
      evidence: { images_without_alt: 5 },
      remediation: 'Anadir alt descriptivo, o alt="" si la imagen es decorativa.',
    },
    {
      id: 'A11Y-LANDMARKS-MISSING',
      modes: ALL_MODES,
      confidence: 'medium',
      count: 1,
      affected: ['/'],
      evidence: { landmarks: [], expected: ['main', 'nav', 'footer'] },
      remediation: 'Envolver el contenido en <main>, <nav> y <footer>.',
    },
    {
      id: 'A11Y-MANUAL-REVIEW-PENDING',
      modes: ALL_MODES,
      confidence: 'high',
      count: 1,
      affected: ['/'],
      evidence: { automated_coverage: '~57%', standard: 'WCAG 2.2 AA' },
      remediation:
        'Complementar con revision humana: cerca del 43% de los criterios WCAG exige juicio.',
    },
  ],
  SEO: [
    {
      id: 'SEO-NOINDEX-UNINTENDED',
      modes: ALL_MODES,
      confidence: 'high',
      count: 1,
      affected: ['/'],
      evidence: { header: 'x-robots-tag: noindex', meta: '<meta name="robots" content="noindex">' },
      remediation: 'Eliminar el noindex de produccion y solicitar reindexacion.',
      title: 'La home esta marcada como no indexable',
    },
    {
      id: 'SEO-H1-MISSING',
      modes: ALL_MODES,
      confidence: 'high',
      count: 1,
      affected: ['/servicios'],
      evidence: { h1_count: 0 },
      remediation: 'Anadir un unico <h1> que describa la pagina.',
    },
    {
      id: 'SEO-META-DESC-MISSING',
      modes: ALL_MODES,
      confidence: 'medium',
      count: 3,
      affected: ['/', '/servicios', '/contacto'],
      evidence: { pages_without_description: 3 },
      remediation: 'Redactar una meta description unica por pagina.',
    },
    {
      id: 'SEO-REDIRECT-CHAIN',
      modes: DEEP_ONLY,
      confidence: 'high',
      count: 2,
      affected: ['/blog', '/blog/'],
      evidence: { hops: 3, chain: ['/blog', '/blog/', '/blog/index'] },
      remediation: 'Redirigir en un solo salto al destino final.',
    },
  ],
  DEPS: [
    {
      id: 'DEPS-VULN-HIGH',
      modes: ALL_MODES,
      confidence: 'low',
      count: 1,
      affected: ['/assets/vendor.js'],
      evidence: { library: 'jquery', detected: '3.4.1', cve: 'CVE-2020-11022' },
      remediation: 'Actualizar jQuery a 3.5.0 o superior.',
    },
    {
      id: 'DEPS-SOURCEMAP-EXPOSED',
      modes: ALL_MODES,
      confidence: 'high',
      count: 1,
      affected: ['/assets/app.js.map'],
      evidence: { url: '/assets/app.js.map', status: 200 },
      remediation: 'No publicar sourcemaps en produccion o restringir su acceso.',
    },
    {
      id: 'DEPS-VERSION-UNDETERMINED',
      modes: ALL_MODES,
      confidence: 'high',
      count: 4,
      affected: ['/assets/vendor.js'],
      evidence: { undetermined: 4, reason: 'bundle minificado sin banner de version' },
      remediation:
        'Correr el diagnostico en modo white-box con el repositorio para leer los lockfiles.',
    },
  ],
  SEC: [
    {
      id: 'SEC-CSP-MISSING',
      modes: ALL_MODES,
      confidence: 'high',
      count: 1,
      affected: ['/'],
      evidence: { header: 'content-security-policy', present: false },
      remediation: 'Publicar una CSP en modo report-only y endurecerla despues.',
    },
    {
      id: 'SEC-HSTS-MISSING',
      modes: ALL_MODES,
      confidence: 'high',
      count: 1,
      affected: ['/'],
      evidence: { header: 'strict-transport-security', present: false },
      remediation: 'Anadir Strict-Transport-Security con max-age de al menos 6 meses.',
    },
  ],
  AGENT: [
    {
      id: 'AGENT-STRUCTURED-DATA-MISSING',
      modes: ALL_MODES,
      confidence: 'medium',
      count: 1,
      affected: ['/'],
      evidence: { jsonld_blocks: 0 },
      remediation: 'Publicar JSON-LD de Organization y de los servicios ofrecidos.',
    },
    {
      id: 'AGENT-LLMSTXT-MISSING',
      modes: ALL_MODES,
      confidence: 'high',
      count: 1,
      affected: ['/llms.txt'],
      evidence: { status: 404, note: 'impacto no probado; Google lo clasifica como mito' },
      remediation:
        'Opcional: publicar /llms.txt. Su impacto no esta demostrado y no penaliza otros ejes.',
    },
  ],
};

/**
 * The Performance `detail` fixture. It exists for the same reason the
 * observations do: phase 0 has to render a complete, realistic report from
 * invented data, and the Lighthouse-style section cannot be exercised without
 * one. It is a literal rather than a call to `perfDetail` so the stub keeps
 * producing a fixed result no matter what the real mapper does.
 */
const PERF_DETAIL_FIXTURE: PerfDetail = {
  schema: 'webdiag.perf/1',
  score: 46,
  scoreState: 'poor',
  metrics: [
    {
      id: 'FCP',
      label: 'First Contentful Paint',
      value: 1200,
      display: '1.2 s',
      unit: 'ms',
      good: 1800,
      poor: 3000,
      state: 'good',
      composesScore: true,
    },
    {
      id: 'LCP',
      label: 'Largest Contentful Paint',
      value: 4120,
      display: '4.1 s',
      unit: 'ms',
      good: 2500,
      poor: 4000,
      state: 'poor',
      composesScore: true,
    },
    {
      id: 'SI',
      label: 'Speed Index',
      value: 3200,
      display: '3.2 s',
      unit: 'ms',
      good: 3400,
      poor: 5800,
      state: 'good',
      composesScore: true,
    },
    {
      id: 'TBT',
      label: 'Total Blocking Time',
      value: 890,
      display: '890 ms',
      unit: 'ms',
      good: 200,
      poor: 600,
      state: 'poor',
      composesScore: true,
      note: 'Proxy de laboratorio para INP; no es INP.',
    },
    {
      id: 'CLS',
      label: 'Cumulative Layout Shift',
      value: 0.06,
      display: '0.06',
      unit: 'score',
      good: 0.1,
      poor: 0.25,
      state: 'good',
      composesScore: true,
    },
    {
      id: 'TTFB',
      label: 'Time to First Byte',
      value: 620,
      display: '620 ms',
      unit: 'ms',
      good: 800,
      poor: 1800,
      state: 'good',
      composesScore: false,
      note: 'No compone el score de Lighthouse.',
    },
  ],
  opportunities: [
    {
      title: 'Eliminar recursos que bloquean el render',
      savingsMs: 1600,
      count: 2,
      examples: ['https://example.com/style.css', 'https://example.com/modernizr.js'],
    },
    {
      title: 'Mejorar la entrega de imagenes',
      savingsKb: 1840,
      count: 12,
      examples: ['https://example.com/img/hero.png'],
    },
  ],
  diagnostics: [
    { title: 'Imagenes sin width/height', count: 5, examples: ['img.logo'] },
    { title: 'Tamano del DOM', detail: '1420 elementos' },
  ],
};

function observationsFor(axis: Axis, mode: Mode): readonly RawObservation[] {
  return (FIXTURE[axis] ?? [])
    .filter((observation) => observation.modes.includes(mode))
    .map(({ modes: _modes, ...observation }) => structuredClone(observation));
}

/** Builds the stub probe for one axis. */
export function stubProbe(axis: Axis): Probe {
  return {
    axis,
    tool: STUB_TOOL,
    run(context: ProbeContext): Promise<RawDocument> {
      return Promise.resolve({
        schema: RAW_SCHEMA_VERSION,
        axis,
        tool: STUB_TOOL,
        target: { url: context.url, mode: context.mode },
        observations: observationsFor(axis, context.mode),
        ...(axis === 'PERF' ? { detail: structuredClone(PERF_DETAIL_FIXTURE) } : {}),
      });
    },
  };
}

/** One stub probe per axis, in catalogue axis order. */
export function stubProbes(): readonly Probe[] {
  return AXES.map(stubProbe);
}
