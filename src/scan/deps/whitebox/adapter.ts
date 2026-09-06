/**
 * `WhiteboxAnalysis` → raw observations.
 *
 * The white-box mirror of `../adapter.ts`, with one structural difference that
 * runs through the whole file: **every detection here is `high` confidence**.
 * The black-box axis hedges between `high` (a byte-exact hash match) and
 * `medium` (a name/content match that could be a backported patch) because it
 * never really knows what version shipped. A white-box run reads the version
 * out of the lockfile itself, so that hedge has nothing left to express —
 * which is exactly the acceptance criterion this file exists to satisfy: no
 * `DEPS-VERSION-UNDETERMINED` in white-box mode, because the version is never
 * undetermined here.
 *
 * Pure, like its sibling: no network, no disk, no clock (`WhiteboxAnalysis.now`
 * is the one exception, injected rather than read, for the same reason
 * `eol.ts` documents).
 */
import type { Confidence, Severity } from '../../../catalog/index.ts';
import type { RawObservation } from '../../raw.ts';
import { classify } from '../mapping.ts';
import type { RetireSeverity } from '../retire.ts';
import type { WhiteboxAnalysis } from './analyze.ts';
import { cycleFor, isEndOfLife, normalizeVersion } from './eol.ts';
import type { OsvGroup, OsvVulnerability } from './osv.ts';
import { isUnmaintained } from './scorecard.ts';

/** Enough evidence to act on; not so much that the raw document balloons. */
const MAX_EVIDENCE_ROWS = 25;

const CONFIDENCE: Confidence = 'high';

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/** The catalogue's own CVSS bands (findings-catalog.md §4, DEPS-VULN-*). */
function severityBucket(score: number | undefined): RetireSeverity {
  if (score === undefined || !Number.isFinite(score)) {
    return 'none';
  }
  if (score >= 9.0) {
    return 'critical';
  }
  if (score >= 7.0) {
    return 'high';
  }
  return score >= 4.0 ? 'medium' : 'low';
}

/** CVE-shaped identifiers among a group's `ids`/`aliases`, deduplicated and sorted. */
function cvesOfGroup(group: OsvGroup): readonly string[] {
  return [...new Set([...group.ids, ...group.aliases])]
    .filter((id) => /^CVE-\d{4}-\d+$/.test(id))
    .sort();
}

/** The vulnerability records a group's aggregate covers, by shared identifier. */
function vulnerabilitiesOfGroup(
  group: OsvGroup,
  vulnerabilities: readonly OsvVulnerability[],
): readonly OsvVulnerability[] {
  const ids = new Set([...group.ids, ...group.aliases]);

  return vulnerabilities.filter(
    (vulnerability) =>
      ids.has(vulnerability.id) || vulnerability.aliases.some((alias) => ids.has(alias)),
  );
}

/** First fixed version named by any range event, across the group's records. */
function fixedVersionsOf(vulnerabilities: readonly OsvVulnerability[]): readonly string[] {
  const fixes = new Set<string>();

  for (const vulnerability of vulnerabilities) {
    for (const affected of vulnerability.affected) {
      for (const range of affected.ranges) {
        for (const event of range.events) {
          if (event.fixed !== undefined) {
            fixes.add(event.fixed);
          }
        }
      }
    }
  }

  return [...fixes].sort();
}

type OsvAdvisoryRow = {
  readonly lockfile: string;
  readonly library: string;
  readonly version: string;
  readonly advisory: string;
  readonly cves: readonly string[];
  readonly fixed_in: readonly string[];
  readonly cvss: number | undefined;
  readonly epss: number | undefined;
  readonly kev: boolean;
  readonly summary: string | undefined;
};

type Bucket = {
  readonly rows: OsvAdvisoryRow[];
  readonly affected: Set<string>;
  readonly fixes: Set<string>;
  severity: Severity | undefined;
};

function bestEpss(
  cves: readonly string[],
  epss: Readonly<Record<string, number>>,
): number | undefined {
  const scores = cves
    .map((cve) => epss[cve])
    .filter((score): score is number => score !== undefined);
  return scores.length === 0 ? undefined : Math.max(...scores);
}

/** One observation per catalogue ID, each carrying every advisory behind it. */
function vulnerabilityObservations(analysis: WhiteboxAnalysis): readonly RawObservation[] {
  const exploited = new Set(analysis.kev.listed);
  const buckets = new Map<string, Bucket>();

  for (const result of analysis.osv.report.results) {
    for (const pkg of result.packages) {
      for (const group of pkg.groups) {
        const cves = cvesOfGroup(group);
        const kev = cves.some((cve) => exploited.has(cve));
        const epss = bestEpss(cves, analysis.epss.scores);
        const score = Number(group.max_severity);
        const classification = classify({
          severity: severityBucket(Number.isFinite(score) ? score : undefined),
          kev,
          epss,
        });

        const vulnerabilities = vulnerabilitiesOfGroup(group, pkg.vulnerabilities);
        const advisory = cves[0] ?? group.ids[0] ?? vulnerabilities[0]?.id ?? 'sin identificador';

        const bucket = buckets.get(classification.id) ?? {
          rows: [],
          affected: new Set<string>(),
          fixes: new Set<string>(),
          severity: classification.severity,
        };

        const row: OsvAdvisoryRow = {
          lockfile: result.source.path,
          library: pkg.package.name,
          version: pkg.package.version,
          advisory,
          cves,
          fixed_in: fixedVersionsOf(vulnerabilities),
          cvss: Number.isFinite(score) ? score : undefined,
          epss: epss === undefined ? undefined : Number(epss.toFixed(5)),
          kev,
          summary: vulnerabilities[0]?.summary?.slice(0, 240),
        };

        bucket.rows.push(row);
        bucket.affected.add(result.source.path);

        for (const fixed of row.fixed_in) {
          bucket.fixes.add(`${row.library}@${fixed}`);
        }

        // Same rule as the black-box adapter: the `low` override only survives
        // while every advisory in the bucket is a low one.
        if (classification.severity === undefined) {
          bucket.severity = undefined;
        }

        buckets.set(classification.id, bucket);
      }
    }
  }

  const REMEDIATION: Readonly<Record<string, string>> = {
    'DEPS-VULN-KEV':
      'Actualizar hoy: CISA la lista como explotada activamente. Si no se puede actualizar, retirar la dependencia o aislar la funcionalidad afectada.',
    'DEPS-VULN-CRITICAL':
      'Actualizar la dependencia a la primera versión corregida que indica la evidencia y volver a desplegar.',
    'DEPS-VULN-HIGH':
      'Actualizar la dependencia a la primera versión corregida que indica la evidencia.',
    'DEPS-VULN-HIGH-EPSS':
      'Priorizar la actualización aunque el CVSS sea moderado: el EPSS indica una probabilidad alta de explotación en los próximos 30 días.',
    'DEPS-VULN-MEDIUM':
      'Planificar la actualización de la dependencia en el próximo ciclo de mantenimiento.',
  };

  return [...buckets.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([id, bucket]) => {
      const rows = [...bucket.rows].sort(
        (left, right) =>
          compareStrings(left.lockfile, right.lockfile) ||
          compareStrings(left.library, right.library) ||
          compareStrings(left.advisory, right.advisory),
      );
      const fixes = [...bucket.fixes].sort();

      return {
        id,
        confidence: CONFIDENCE,
        count: rows.length,
        affected: [...bucket.affected].sort(),
        evidence: {
          mode: 'white-box',
          advisories: rows.slice(0, MAX_EVIDENCE_ROWS),
          ...(rows.length > MAX_EVIDENCE_ROWS ? { omitted: rows.length - MAX_EVIDENCE_ROWS } : {}),
          ...(fixes.length === 0 ? {} : { fixed_in: fixes }),
          source: 'osv.dev',
        },
        remediation: REMEDIATION[id] ?? REMEDIATION['DEPS-VULN-MEDIUM'] ?? '',
        ...(bucket.severity === undefined ? {} : { severity: bucket.severity }),
      };
    });
}

/** `DEPS-LIB-DEPRECATED`: the maintainer's own statement, straight from npm. */
function deprecatedObservation(analysis: WhiteboxAnalysis): readonly RawObservation[] {
  const rows = Object.values(analysis.npm.facts)
    .filter((fact) => fact.deprecated !== undefined)
    .sort(
      (left, right) =>
        compareStrings(left.name, right.name) || compareStrings(left.version, right.version),
    );

  if (rows.length === 0) {
    return [];
  }

  return [
    {
      id: 'DEPS-LIB-DEPRECATED',
      confidence: CONFIDENCE,
      count: rows.length,
      affected: rows.map((row) => `${row.name}@${row.version}`),
      evidence: {
        packages: rows.slice(0, MAX_EVIDENCE_ROWS).map((row) => ({
          name: row.name,
          version: row.version,
          message: row.deprecated,
        })),
        ...(rows.length > MAX_EVIDENCE_ROWS ? { omitted: rows.length - MAX_EVIDENCE_ROWS } : {}),
        source: 'registry.npmjs.org',
      },
      remediation:
        'Reemplazar el paquete deprecated por la alternativa que indique su propio aviso, o por un sustituto activamente mantenido.',
    },
  ];
}

/** `DEPS-LIB-UNMAINTAINED`: OpenSSF Scorecard's `Maintained` check, at or below the floor. */
function unmaintainedObservation(analysis: WhiteboxAnalysis): readonly RawObservation[] {
  const unmaintained = Object.values(analysis.scorecard.verdicts)
    .filter(isUnmaintained)
    .sort((left, right) => compareStrings(left.repository, right.repository));

  if (unmaintained.length === 0) {
    return [];
  }

  const packagesByRepository = new Map<string, string[]>();

  for (const fact of Object.values(analysis.npm.facts)) {
    if (fact.repository === undefined) {
      continue;
    }
    const packages = packagesByRepository.get(fact.repository) ?? [];
    packages.push(`${fact.name}@${fact.version}`);
    packagesByRepository.set(fact.repository, packages);
  }

  // `count` and `affected` share one unit — the installed packages — because the
  // finding schema requires `affected.length <= count`. A repository that
  // publishes three packages is three affected places; a repository no package
  // fact points back to is listed by its own URL so the finding still has a
  // place to point at. The per-repository breakdown lives in `evidence`.
  const affected = [
    ...new Set(
      unmaintained.flatMap((verdict) => {
        const packages = packagesByRepository.get(verdict.repository) ?? [];
        return packages.length === 0 ? [verdict.repository] : packages;
      }),
    ),
  ].sort();

  return [
    {
      id: 'DEPS-LIB-UNMAINTAINED',
      confidence: CONFIDENCE,
      count: affected.length,
      affected,
      evidence: {
        repository_count: unmaintained.length,
        repositories: unmaintained.map((verdict) => ({
          repository: verdict.repository,
          maintained_score: verdict.score,
          overall_score: verdict.overall,
          evaluated_at: verdict.evaluatedAt,
          reason: verdict.reason,
          packages: (packagesByRepository.get(verdict.repository) ?? []).sort(),
        })),
        source: 'api.scorecard.dev',
      },
      remediation:
        'Planificar una alternativa: OpenSSF Scorecard no ve actividad de mantenimiento reciente en el repositorio de este paquete.',
    },
  ];
}

/** `DEPS-RUNTIME-EOL`: a declared runtime or framework whose support window has closed. */
function runtimeEolObservation(analysis: WhiteboxAnalysis): readonly RawObservation[] {
  const rows = analysis.repo.runtimes
    .flatMap((runtime) => {
      const version = normalizeVersion(runtime.declared);
      const product = version === undefined ? undefined : analysis.eol.products[runtime.product];
      const cycle =
        product === undefined || version === undefined
          ? undefined
          : cycleFor(version, product.cycles);

      if (cycle === undefined || !isEndOfLife(cycle, analysis.now)) {
        return [];
      }

      return [
        {
          product: runtime.product,
          label: runtime.label,
          declared: runtime.declared,
          source: runtime.source,
          cycle: cycle.cycle,
          eol: cycle.eol,
          latest: cycle.latest,
        },
      ];
    })
    .sort(
      (left, right) =>
        compareStrings(left.source, right.source) || compareStrings(left.product, right.product),
    );

  if (rows.length === 0) {
    return [];
  }

  return [
    {
      id: 'DEPS-RUNTIME-EOL',
      confidence: CONFIDENCE,
      count: rows.length,
      affected: [...new Set(rows.map((row) => row.source))].sort(),
      evidence: { runtimes: rows, source: 'endoflife.date' },
      remediation:
        'Actualizar el runtime o framework a una versión dentro de soporte activo antes de que termine el ciclo declarado.',
    },
  ];
}

/** `DEPS-LINT-ERRORS`: problems the project's own ESLint configuration flags as errors. */
function lintErrorsObservation(analysis: WhiteboxAnalysis): readonly RawObservation[] {
  if (!analysis.eslint.available) {
    return [];
  }

  const root = analysis.repo.root;
  const filesWithErrors = analysis.eslint.results.filter((file) => file.errorCount > 0);

  if (filesWithErrors.length === 0) {
    return [];
  }

  const relativePath = (filePath: string): string =>
    filePath.startsWith(`${root}/`) ? filePath.slice(root.length + 1) : filePath;

  const rows = filesWithErrors
    .map((file) => ({
      file: relativePath(file.filePath),
      error_count: file.errorCount,
      warning_count: file.warningCount,
      messages: file.messages
        .filter((message) => message.severity === 2)
        .slice(0, MAX_EVIDENCE_ROWS)
        .map((message) => ({
          rule: message.ruleId,
          message: message.message.slice(0, 240),
          line: message.line,
          column: message.column,
        })),
    }))
    .sort((left, right) => compareStrings(left.file, right.file));

  const totalErrors = rows.reduce((sum, row) => sum + row.error_count, 0);
  const totalWarnings = analysis.eslint.results.reduce((sum, file) => sum + file.warningCount, 0);

  return [
    {
      id: 'DEPS-LINT-ERRORS',
      confidence: CONFIDENCE,
      count: totalErrors,
      affected: rows.map((row) => row.file),
      evidence: {
        files: rows.slice(0, MAX_EVIDENCE_ROWS),
        ...(rows.length > MAX_EVIDENCE_ROWS ? { omitted: rows.length - MAX_EVIDENCE_ROWS } : {}),
        total_warnings: totalWarnings,
        source: 'eslint (configuración propia del proyecto analizado)',
      },
      remediation:
        'Corregir los errores que reporta la configuración de ESLint del propio proyecto antes de desplegar.',
    },
  ];
}

/**
 * `toObservations`'s white-box counterpart. Deliberately does **not** call
 * anything that would emit `DEPS-VERSION-UNDETERMINED` — see the file header.
 */
export function toWhiteboxObservations(analysis: WhiteboxAnalysis): readonly RawObservation[] {
  return [
    ...vulnerabilityObservations(analysis),
    ...deprecatedObservation(analysis),
    ...unmaintainedObservation(analysis),
    ...runtimeEolObservation(analysis),
    ...lintErrorsObservation(analysis),
  ];
}
