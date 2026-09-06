/**
 * The I/O half of the DEPS probe: download, scan, look up, hand over.
 *
 * It exists so `adapter.ts` can stay pure. Everything with a side effect — the
 * browser, the temp directory, the retire.js subprocess, the three public feeds
 * — happens here and is reduced to one plain `DepsAnalysis` value.
 *
 * The temp directory is the invariant this file guards. `withWorkspace` lends it
 * for the length of the analysis and removes it afterwards no matter how the
 * analysis ends, so a retire.js crash cannot leave a copy of a client's bundles
 * on disk.
 */
import type { ProbeContext } from '../probe.ts';
import type { DepsAnalysis, LibraryHit } from './adapter.ts';
import type { JsAsset } from './assets.ts';
import { collectServedScripts } from './collector.ts';
import { type Enrichment, fetchEpss, fetchKev, fetchLatestVersions } from './enrichment.ts';
import { cvesOf, npmNameFor } from './mapping.ts';
import type { RetireReport } from './retire.ts';
import { RETIRE_VERSION, scanWithRetire } from './retire.ts';
import { detectLibraries } from './signatures.ts';
import { findExposedSourcemaps } from './sourcemaps.ts';
import { withWorkspace } from './workspace.ts';

/** Which libraries each bundle shows, for the ones retire.js cannot version. */
export async function detectLibraryHits(
  assets: readonly JsAsset[],
): Promise<readonly LibraryHit[]> {
  const hits: LibraryHit[] = [];

  for (const asset of assets) {
    const content = await Bun.file(asset.path)
      .text()
      .catch(() => '');

    for (const library of detectLibraries(content)) {
      hits.push({ assetUrl: asset.url, library });
    }
  }

  return hits;
}

function advisoryCves(report: RetireReport): readonly string[] {
  return report.data.flatMap((file) =>
    file.results.flatMap((result) => result.vulnerabilities.flatMap(cvesOf)),
  );
}

function npmNames(report: RetireReport): readonly string[] {
  return report.data.flatMap((file) => file.results.map(npmNameFor));
}

/**
 * The three feeds are queried together because they are independent, and only
 * when there is something to ask: a page with no recognised library never
 * downloads the KEV catalogue.
 */
async function enrich(report: RetireReport): Promise<Enrichment> {
  const cves = advisoryCves(report);
  const [kev, epss, registry] = await Promise.all([
    fetchKev(cves),
    fetchEpss(cves),
    fetchLatestVersions(npmNames(report)),
  ]);

  return { kev, epss, registry };
}

/**
 * retire.js, or an empty report that says why there is none.
 *
 * The advisory scan is the axis's centrepiece, but it is not the whole axis:
 * exposed source maps and `DEPS-VERSION-UNDETERMINED` are established from the
 * downloaded bundles alone. Letting a retire.js that cannot start — no
 * definitions to fetch on a cold cache behind a proxy, a sandbox that refuses
 * the subprocess — take those down with it would trade real findings for an
 * empty axis.
 *
 * The failure is not swallowed: it lands in `report.errors`, which the adapter
 * publishes as `retire_errors` on `DEPS-VERSION-UNDETERMINED`. So the report
 * degrades to "these are the limits of what this run could check", never to a
 * silent "no vulnerabilities found".
 */
export async function scanOrDegrade(directory: string): Promise<RetireReport> {
  try {
    return await scanWithRetire(directory);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);

    return {
      version: RETIRE_VERSION,
      data: [],
      messages: [],
      errors: [`retire.js no pudo ejecutarse en este entorno: ${detail}`],
      vulnerabilityRepositories: [],
    };
  }
}

export async function analyzeServedBundles(context: ProbeContext): Promise<DepsAnalysis> {
  return withWorkspace(async (workspace) => {
    const collection = await collectServedScripts(context, workspace);
    const retire = await scanOrDegrade(collection.directory);

    const [libraries, sourcemaps, enrichment] = await Promise.all([
      detectLibraryHits(collection.assets),
      findExposedSourcemaps(collection.assets),
      enrich(retire),
    ]);

    return { collection, retire, libraries, sourcemaps, enrichment };
  });
}
