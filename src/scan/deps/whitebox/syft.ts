/**
 * Syft: the SBOM, and the package inventory that comes with it.
 *
 * The ticket asks for an SBOM of the project, and CycloneDX JSON is what it is
 * emitted as — it is the format osv-scanner, Dependency-Track and GitHub all
 * ingest, so the artifact is useful to somebody other than this tool. It is
 * written as its own file rather than embedded in `raw/DEPS.json`, because an
 * SBOM of a real front-end is megabytes of components and nothing reading the
 * raw document wants them inline.
 *
 * One gotcha is worth the comment it costs: **Syft is always given an absolute
 * path**. `syft scan dir:.` resolves the relative path against something other
 * than the caller's working directory and will happily catalogue a tree that is
 * not the one asked for. Passing `dir:<absolute>` is the difference between an
 * SBOM of the client's repo and an SBOM of whatever happened to be nearby.
 */
import type { ToolVersion } from '../../raw.ts';
import { type CommandRunner, runCommand } from '../../sec/curl.ts';
import { type Inventory, inventoryFromCycloneDx } from './inventory.ts';

export const SYFT_TOOL_NAME = 'syft';

/** The SBOM's filename inside the output directory. */
export const SBOM_ARTIFACT = 'sbom.cdx.json';

export const SBOM_FORMAT = 'cyclonedx-json';

/** Cataloguing a checkout with a populated `node_modules` is not instant. */
export const SYFT_TIMEOUT_MS = 240_000;

export type SyftScan = {
  readonly available: boolean;
  readonly version: string | undefined;
  /** The CycloneDX document, verbatim, ready to be written as an artifact. */
  readonly sbom: string | undefined;
  readonly components: number;
  readonly inventory: Inventory;
  readonly errors: readonly string[];
};

export const UNAVAILABLE_SYFT: SyftScan = {
  available: false,
  version: undefined,
  sbom: undefined,
  components: 0,
  inventory: { packages: [], source: 'none' },
  errors: [],
};

async function exists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

/** Override, then PATH, then the vendored copy. `undefined` degrades the probe. */
export async function locateSyft(): Promise<string | undefined> {
  const override = Bun.env.WEBDIAG_SYFT;

  if (override !== undefined && override !== '' && (await exists(override))) {
    return override;
  }

  const onPath = Bun.which('syft');

  if (onPath !== null) {
    return onPath;
  }

  const vendored = `${import.meta.dir}/../../../../vendor/syft`;

  return (await exists(vendored)) ? vendored : undefined;
}

/** `Version: 1.51.1` out of `syft version`. Recorded in `meta.json`. */
export async function syftVersion(
  path: string,
  runner: CommandRunner = runCommand,
): Promise<string | undefined> {
  try {
    const result = await runner([path, 'version', '--output', 'text'], { timeoutMs: 30_000 });
    return /^\s*Version:\s*(\S+)/im.exec(result.stdout)?.[1];
  } catch {
    return undefined;
  }
}

export type SyftRun = {
  readonly path: string;
  /** Absolute path. A relative one is not resolved the way callers expect. */
  readonly root: string;
  readonly runner?: CommandRunner;
  readonly timeoutMs?: number;
};

export async function runSyft(options: SyftRun): Promise<SyftScan> {
  const runner = options.runner ?? runCommand;
  const version = await syftVersion(options.path, runner);

  const result = await runner(
    [options.path, 'scan', `dir:${options.root}`, '--output', SBOM_FORMAT, '--quiet'],
    { timeoutMs: options.timeoutMs ?? SYFT_TIMEOUT_MS },
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `syft exited with ${result.exitCode}: ${
        result.stderr.trim().split('\n').at(-1)?.slice(0, 300) ?? 'no diagnostics'
      }`,
    );
  }

  let document: unknown;

  try {
    document = JSON.parse(result.stdout);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`syft produced an SBOM this build cannot read: ${detail}`);
  }

  const packages = inventoryFromCycloneDx(document);

  return {
    available: true,
    version,
    sbom: result.stdout,
    components: Array.isArray((document as { components?: unknown }).components)
      ? (document as { components: readonly unknown[] }).components.length
      : 0,
    inventory: { packages, source: 'syft' },
    errors: [],
  };
}

/** The SBOM, or an empty result that says why there is none. */
export async function syftScanOrDegrade(root: string): Promise<SyftScan> {
  const path = await locateSyft();

  if (path === undefined) {
    return {
      ...UNAVAILABLE_SYFT,
      errors: [
        'Syft no está instalado: no se generó el SBOM del proyecto. Instalarlo con `bun run install:whitebox`.',
      ],
    };
  }

  try {
    return await runSyft({ path, root });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);

    return { ...UNAVAILABLE_SYFT, errors: [`Syft no pudo ejecutarse en este entorno: ${detail}`] };
  }
}

export function syftComponent(version: string | undefined): ToolVersion {
  return { name: SYFT_TOOL_NAME, version: version ?? 'unavailable' };
}
