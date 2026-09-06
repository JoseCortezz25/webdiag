/**
 * Parsing for `webdiag scan` (spec §4.2).
 *
 * Returns a result instead of throwing, and never writes: the caller decides
 * what a bad invocation looks like on stderr. Every rejection names the flag and
 * the accepted values, because "invalid argument" costs the operator a trip to
 * `--help` that the error message could have saved.
 */
import type { Axis, Mode } from '../catalog/index.ts';
import { AXES } from '../catalog/index.ts';
import type { ScanRequest } from './orchestrator.ts';

/** Modes reachable from the CLI. `whitebox` is implied by `--repo`, not asked for. */
const CLI_MODES: readonly Mode[] = ['quick', 'deep'];

export const DEFAULT_OUT_DIR = './webdiag-out';

/** `quick` is one URL with no crawl (spec §5.2); `deep` samples 5–10 pages. */
const DEFAULT_PAGES: Readonly<Record<string, number>> = { quick: 1, deep: 5 };

export type ParsedScan = { readonly ok: true; readonly request: ScanRequest };
export type ParseError = { readonly ok: false; readonly error: string };
export type ScanArgsResult = ParsedScan | ParseError;

function fail(error: string): ParseError {
  return { ok: false, error };
}

function parseAxes(value: string): readonly Axis[] | undefined {
  const requested = value
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part !== '');

  if (requested.length === 0) {
    return undefined;
  }

  const known = new Set<string>(AXES);

  if (requested.some((axis) => !known.has(axis))) {
    return undefined;
  }

  // Normalised to catalogue order so `--axes SEO,PERF` and `--axes PERF,SEO`
  // cannot produce two different artifact orderings.
  return AXES.filter((axis) => requested.includes(axis));
}

export function parseScanArgs(argv: readonly string[]): ScanArgsResult {
  let url: string | undefined;
  let mode: Mode = 'quick';
  let out: string = DEFAULT_OUT_DIR;
  let repo: string | undefined;
  let axes: readonly Axis[] = AXES;
  let pages: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === undefined) {
      continue;
    }

    if (!token.startsWith('--')) {
      if (url !== undefined) {
        return fail(`unexpected argument '${token}': scan takes a single URL`);
      }
      url = token;
      continue;
    }

    const value = argv[index + 1];

    if (value === undefined || value.startsWith('--')) {
      return fail(`${token} requires a value`);
    }

    index += 1;

    switch (token) {
      case '--mode': {
        const candidate = CLI_MODES.find((known) => known === value);
        if (candidate === undefined) {
          return fail(`--mode must be one of: ${CLI_MODES.join(', ')}`);
        }
        mode = candidate;
        break;
      }
      case '--out':
        out = value;
        break;
      case '--repo':
        repo = value;
        break;
      case '--axes': {
        const parsed = parseAxes(value);
        if (parsed === undefined) {
          return fail(`--axes must be a comma-separated subset of: ${AXES.join(', ')}`);
        }
        axes = parsed;
        break;
      }
      case '--pages': {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) {
          return fail('--pages must be a positive integer');
        }
        pages = parsed;
        break;
      }
      default:
        return fail(`unknown option '${token}'`);
    }
  }

  if (url === undefined) {
    return fail('scan requires a URL');
  }

  if (!/^https?:\/\//i.test(url)) {
    return fail(`'${url}' is not an http(s) URL`);
  }

  return {
    ok: true,
    request: {
      url,
      mode,
      axes,
      pages: pages ?? DEFAULT_PAGES[mode] ?? 1,
      out,
      repo,
    },
  };
}
