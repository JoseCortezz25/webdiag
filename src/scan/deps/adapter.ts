/**
 * retire.js report + signatures + source maps + public feeds → raw observations.
 *
 * Pure: no network, no disk, no clock. Everything the probe learned arrives as
 * a `DepsAnalysis` value, which is what makes the interesting cases — a KEV hit,
 * a library with no resolvable version, an unreachable feed — testable from a
 * fixture instead of from a live site.
 *
 * One shaping decision runs through the whole file: **observations are
 * aggregated per catalogue ID here, not left to merge in the normalizer.** The
 * normalizer's merge keeps the evidence of the first occurrence only (spec §6,
 * "un hallazgo repetido en N páginas es uno con count: N"), which is right for
 * a contrast ratio and wrong for a CVE list — a `count: 7` whose evidence names
 * one advisory hides six. So each ID is emitted once, carrying every advisory
 * behind it.
 */
import type { Confidence, Severity } from '../../catalog/index.ts';
import type { RawObservation } from '../raw.ts';
import type { AssetCollection } from './assets.ts';
import { displayPath } from './assets.ts';
import type { Enrichment } from './enrichment.ts';
import {
  advisoryId,
  type Classification,
  classify,
  confidenceFor,
  cvesOf,
  isMajorBehind,
  isVendoredRuntimeVersion,
  npmNameFor,
} from './mapping.ts';
import type { RetireReport, RetireResult } from './retire.ts';
import type { SourcemapFinding } from './sourcemaps.ts';

/** A library a signature recognised in a bundle, with no version attached. */
export type LibraryHit = {
  readonly assetUrl: string;
  readonly library: string;
};

export type DepsAnalysis = {
  readonly collection: AssetCollection;
  readonly retire: RetireReport;
  readonly libraries: readonly LibraryHit[];
  readonly sourcemaps: readonly SourcemapFinding[];
  readonly enrichment: Enrichment;
};

/** Enough advisories to act on; not so many that `findings.json` becomes a feed. */
const MAX_EVIDENCE_ROWS = 25;

const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = { high: 0, medium: 1, low: 2 };

type AdvisoryRow = {
  readonly asset: string;
  readonly library: string;
  readonly version: string;
  readonly advisory: string;
  readonly cves: readonly string[];
  readonly fixed_in: string | undefined;
  readonly retire_severity: string;
  readonly epss: number | undefined;
  readonly kev: boolean;
  readonly detection: string;
  readonly summary: string | undefined;
};

type Bucket = {
  readonly classification: Classification;
  readonly rows: AdvisoryRow[];
  readonly affected: Set<string>;
  readonly fixes: Set<string>;
  confidence: Confidence;
  /** Cleared as soon as one member of the bucket is worse than `low`. */
  severity: Severity | undefined;
};

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/** retire.js reports absolute paths; the reader needs the URL it came from. */
function assetIndex(collection: AssetCollection): ReadonlyMap<string, string> {
  return new Map(collection.assets.map((asset) => [asset.path, asset.url]));
}

function bestEpss(cves: readonly string[], enrichment: Enrichment): number | undefined {
  const scores = cves
    .map((cve) => enrichment.epss.scores[cve])
    .filter((score): score is number => score !== undefined);

  return scores.length === 0 ? undefined : Math.max(...scores);
}

function toRow(
  assetUrl: string,
  origin: string,
  result: RetireResult,
  vulnerability: RetireResult['vulnerabilities'][number],
  kev: boolean,
  epss: number | undefined,
): AdvisoryRow {
  return {
    asset: displayPath(assetUrl, origin),
    library: result.component,
    version: result.version,
    advisory: advisoryId(vulnerability),
    cves: cvesOf(vulnerability),
    fixed_in: vulnerability.below,
    retire_severity: vulnerability.severity,
    epss: epss === undefined ? undefined : Number(epss.toFixed(5)),
    kev,
    detection: result.detection,
    summary: vulnerability.identifiers.summary?.slice(0, 240),
  };
}

const REMEDIATION: Readonly<Record<string, string>> = {
  'DEPS-VULN-KEV':
    'Actualizar hoy: CISA la lista como explotada activamente. Si no se puede actualizar, retirar la librería del bundle o aislar la funcionalidad afectada.',
  'DEPS-VULN-CRITICAL':
    'Actualizar la librería a la primera versión corregida que indica la evidencia y volver a desplegar.',
  'DEPS-VULN-HIGH':
    'Actualizar la librería a la primera versión corregida que indica la evidencia.',
  'DEPS-VULN-HIGH-EPSS':
    'Priorizar la actualización aunque el CVSS sea moderado: el EPSS indica una probabilidad alta de explotación en los próximos 30 días.',
  'DEPS-VULN-MEDIUM':
    'Planificar la actualización de la librería en el próximo ciclo de mantenimiento.',
};

function observationFor(id: string, bucket: Bucket): RawObservation {
  const rows = [...bucket.rows].sort(
    (left, right) =>
      compareStrings(left.asset, right.asset) ||
      compareStrings(left.library, right.library) ||
      compareStrings(left.advisory, right.advisory),
  );

  const fixes = [...bucket.fixes].sort();

  return {
    id,
    confidence: bucket.confidence,
    count: rows.length,
    affected: [...bucket.affected].sort(),
    evidence: {
      advisories: rows.slice(0, MAX_EVIDENCE_ROWS),
      ...(rows.length > MAX_EVIDENCE_ROWS ? { omitted: rows.length - MAX_EVIDENCE_ROWS } : {}),
      ...(fixes.length === 0 ? {} : { fixed_in: fixes }),
      reason: bucket.classification.reason,
    },
    remediation: REMEDIATION[id] ?? REMEDIATION['DEPS-VULN-MEDIUM'] ?? '',
    ...(bucket.severity === undefined ? {} : { severity: bucket.severity }),
  };
}

/** One observation per catalogue ID, each carrying every advisory behind it. */
function vulnerabilityObservations(analysis: DepsAnalysis): readonly RawObservation[] {
  const urls = assetIndex(analysis.collection);
  const origin = analysis.collection.pageOrigin;
  const exploited = new Set(analysis.enrichment.kev.listed);
  const buckets = new Map<string, Bucket>();

  for (const file of analysis.retire.data) {
    const assetUrl = urls.get(file.file) ?? file.file;

    for (const result of file.results) {
      for (const vulnerability of result.vulnerabilities) {
        const cves = cvesOf(vulnerability);
        const kev = cves.some((cve) => exploited.has(cve));
        const epss = bestEpss(cves, analysis.enrichment);
        const classification = classify({ severity: vulnerability.severity, kev, epss });
        const confidence = confidenceFor(result.detection);

        const bucket = buckets.get(classification.id) ?? {
          classification,
          rows: [],
          affected: new Set<string>(),
          fixes: new Set<string>(),
          confidence,
          severity: classification.severity,
        };

        bucket.rows.push(toRow(assetUrl, origin, result, vulnerability, kev, epss));
        bucket.affected.add(displayPath(assetUrl, origin));

        if (vulnerability.below !== undefined) {
          bucket.fixes.add(`${result.component}@${vulnerability.below}`);
        }

        if (CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[bucket.confidence]) {
          bucket.confidence = confidence;
        }

        // The `low` override only survives while every advisory in the bucket
        // is a low one. One genuine medium and the catalogue severity stands.
        if (classification.severity === undefined) {
          bucket.severity = undefined;
        }

        buckets.set(classification.id, bucket);
      }
    }
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([id, bucket]) => observationFor(id, bucket));
}

/**
 * `DEPS-LIB-OUTDATED`: at least one major behind what npm publishes.
 *
 * Only the major is compared. A patch or minor behind is normal operation, and
 * reporting it would bury the case the catalogue actually describes — a library
 * far enough behind that security fixes have stopped arriving for it.
 *
 * A framework-vendored canary/nightly build is excluded outright (issue #12):
 * see `isVendoredRuntimeVersion` for why comparing it against npm's latest
 * stable tag is not a gap the site owner can close.
 */
function outdatedObservation(analysis: DepsAnalysis): readonly RawObservation[] {
  const urls = assetIndex(analysis.collection);
  const origin = analysis.collection.pageOrigin;
  const rows = new Map<
    string,
    { library: string; npm: string; version: string; latest: string; assets: Set<string> }
  >();

  for (const file of analysis.retire.data) {
    const assetUrl = urls.get(file.file) ?? file.file;

    for (const result of file.results) {
      const npm = npmNameFor(result);
      const latest = analysis.enrichment.registry.latest[npm];

      if (
        latest === undefined ||
        !isMajorBehind(result.version, latest) ||
        isVendoredRuntimeVersion(result.version)
      ) {
        continue;
      }

      const key = `${npm}@${result.version}`;
      const row = rows.get(key) ?? {
        library: result.component,
        npm,
        version: result.version,
        latest,
        assets: new Set<string>(),
      };

      row.assets.add(displayPath(assetUrl, origin));
      rows.set(key, row);
    }
  }

  if (rows.size === 0) {
    return [];
  }

  const listed = [...rows.values()].sort((left, right) => compareStrings(left.npm, right.npm));
  const affected = [...new Set(listed.flatMap((row) => [...row.assets]))].sort();

  // `count` and `affected` share one unit — the served assets — because the
  // finding schema requires `affected.length <= count`. One outdated library
  // served from two bundles is two affected places; the per-library breakdown
  // lives in `evidence.libraries`, with its own total.
  return [
    {
      id: 'DEPS-LIB-OUTDATED',
      confidence: 'medium',
      count: affected.length,
      affected,
      evidence: {
        library_count: listed.length,
        libraries: listed.map((row) => ({
          library: row.library,
          npm: row.npm,
          detected: row.version,
          latest: row.latest,
          assets: [...row.assets].sort(),
        })),
        source: 'registry.npmjs.org',
      },
      remediation:
        'Planificar la actualización a la versión mayor vigente: una librería con un major de retraso deja de recibir parches de seguridad.',
    },
  ];
}

/**
 * `DEPS-SOURCEMAP-EXPOSED`. The catalogue makes DEPS the owning axis and lets
 * SEC mention it without deducting, so the probe emits it once here and the
 * normalizer routes it; nothing about that split lives in this file.
 *
 * Third-party maps are dropped before anything else (issue #12). A public
 * package served from a CDN — `gsap`, `swiper` — routinely publishes its own
 * sourcemap; that reveals the library author's source, not the client's. The
 * calibration run against `hipintocol.co` reported "el código fuente original
 * de la aplicación es descargable" for exactly that case: two jsDelivr-hosted
 * packages, zero lines of the client's own code. Only same-origin maps can
 * expose the application this finding is about.
 */
function sourcemapObservation(analysis: DepsAnalysis): readonly RawObservation[] {
  const firstParty = analysis.sourcemaps.filter((map) => !map.thirdParty);

  if (firstParty.length === 0) {
    return [];
  }

  const origin = analysis.collection.pageOrigin;
  const maps = [...firstParty].sort((left, right) => compareStrings(left.asset, right.asset));
  const withSource = maps.filter((map) => map.sourcesContent).length;

  return [
    {
      id: 'DEPS-SOURCEMAP-EXPOSED',
      confidence: 'high',
      count: maps.length,
      affected: [...new Set(maps.map((map) => displayPath(map.asset, origin)))].sort(),
      evidence: {
        maps: maps.slice(0, MAX_EVIDENCE_ROWS).map((map) => ({
          asset: displayPath(map.asset, origin),
          map: map.kind === 'inline' ? 'inline' : map.url,
          kind: map.kind,
          status: map.status,
          sources: map.sources,
          sources_content: map.sourcesContent,
        })),
        ...(maps.length > MAX_EVIDENCE_ROWS ? { omitted: maps.length - MAX_EVIDENCE_ROWS } : {}),
        with_original_source: withSource,
      },
      remediation:
        withSource > 0
          ? 'Dejar de publicar los sourcemaps en producción: los que están expuestos incluyen el código fuente original. Subirlos solo al servicio de errores, o restringir su acceso.'
          : 'Dejar de publicar los sourcemaps en producción, o restringir su acceso a los servicios que los necesitan.',
      ...(withSource > 0
        ? { title: 'El código fuente original de la aplicación es descargable' }
        : {}),
    },
  ];
}

/**
 * `DEPS-VERSION-UNDETERMINED` — always emitted, by catalogue rule.
 *
 * This is the finding that keeps the axis honest. A black-box run reads
 * bundles, not lockfiles: bundlers strip the version banners retire.js matches
 * on, so a page can ship a library the probe recognises perfectly well and
 * still refuse to name its version. Without this finding, "0 vulnerabilidades"
 * would read as "está limpio", which is the exact misreading the catalogue note
 * forbids.
 *
 * It is emitted even when every library resolved, because the *method* is still
 * partial — and its evidence then says so, along with which public feeds
 * answered, since an unreachable KEV feed also narrows what the axis can claim.
 */
function undeterminedObservation(analysis: DepsAnalysis): RawObservation {
  const origin = analysis.collection.pageOrigin;
  const resolved = new Set<string>();

  const urls = assetIndex(analysis.collection);

  for (const file of analysis.retire.data) {
    const assetUrl = urls.get(file.file) ?? file.file;

    for (const result of file.results) {
      resolved.add(`${assetUrl}::${result.component.toLowerCase()}`);
    }
  }

  const undetermined = analysis.libraries
    .filter((hit) => !resolved.has(`${hit.assetUrl}::${hit.library.toLowerCase()}`))
    .map((hit) => ({ asset: displayPath(hit.assetUrl, origin), library: hit.library }))
    .sort(
      (left, right) =>
        compareStrings(left.asset, right.asset) || compareStrings(left.library, right.library),
    );

  const libraries = [...new Set(undetermined.map((hit) => hit.library))].sort();

  return {
    id: 'DEPS-VERSION-UNDETERMINED',
    confidence: 'high',
    // `count` is a positive integer by contract; a run that pinned every
    // version still reports the one limitation of having read only bundles.
    count: Math.max(1, undetermined.length),
    affected: [...new Set(undetermined.map((hit) => hit.asset))].sort(),
    evidence: {
      mode: 'black-box',
      undetermined: undetermined.length,
      libraries,
      detections: undetermined.slice(0, MAX_EVIDENCE_ROWS),
      assets_scanned: analysis.collection.assets.length,
      assets_skipped: analysis.collection.skipped.length,
      components_resolved: resolved.size,
      navigation_timed_out: analysis.collection.navigationTimedOut,
      feeds: {
        kev: analysis.enrichment.kev.available,
        epss: analysis.enrichment.epss.available,
        npm_registry: analysis.enrichment.registry.available,
      },
      ...(analysis.enrichment.kev.catalogVersion === undefined
        ? {}
        : { kev_catalog: analysis.enrichment.kev.catalogVersion }),
      advisory_repositories: analysis.retire.vulnerabilityRepositories,
      ...(analysis.collection.skipped.length === 0
        ? {}
        : { skipped: analysis.collection.skipped.slice(0, MAX_EVIDENCE_ROWS) }),
      ...(analysis.retire.errors.length === 0 ? {} : { retire_errors: analysis.retire.errors }),
    },
    remediation:
      'Correr el diagnóstico en modo white-box con acceso al repositorio: los lockfiles dan la versión exacta de cada dependencia, incluidas las que no llegan al bundle.',
  };
}

export function toObservations(analysis: DepsAnalysis): readonly RawObservation[] {
  return [
    ...vulnerabilityObservations(analysis),
    ...outdatedObservation(analysis),
    ...sourcemapObservation(analysis),
    undeterminedObservation(analysis),
  ];
}
