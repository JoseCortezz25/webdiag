/**
 * What the checkout says about itself.
 *
 * The white-box run starts here: before any tool is spawned, the probe has to
 * know which lockfiles exist, which packages the project asked for directly, and
 * which runtimes it declares. Those three facts decide everything downstream —
 * osv-scanner needs a directory with lockfiles in it, the npm and Scorecard
 * lookups are bounded to direct dependencies, and `DEPS-RUNTIME-EOL` has nothing
 * to check unless a version was declared somewhere.
 *
 * Everything here reads and nothing here judges. A missing file is a normal
 * outcome, not an error: a repo with no `package.json` is a repo the JavaScript
 * checks cannot speak about, and saying so is the probe's job, not this file's.
 */
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/** Lockfiles osv-scanner and Syft both understand, and we can name in evidence. */
export const LOCKFILE_NAMES: readonly string[] = [
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
  'yarn.lock',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  'Pipfile.lock',
  'requirements.txt',
  'go.sum',
  'Cargo.lock',
];

/** Directories a dependency walk must never descend into. */
const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'vendor',
  '.next',
  '.nuxt',
  'coverage',
  '.venv',
  'target',
]);

/**
 * How deep the lockfile walk goes. Monorepos keep their lockfiles at the root or
 * one or two levels down (`packages/<name>/`, `apps/<name>/`); going deeper buys
 * nothing and turns a scan of a large checkout into a full filesystem walk.
 */
const MAX_DEPTH = 3;

/** A cap on how many lockfiles are reported, so evidence stays readable. */
const MAX_LOCKFILES = 50;

export type DirectDependency = {
  readonly name: string;
  /** The range as declared, not as resolved. `^4.17.15`, `workspace:*`, … */
  readonly range: string;
  readonly dev: boolean;
};

/** A runtime or framework version the repo declares, and where it said it. */
export type RuntimeDeclaration = {
  /** endoflife.date product slug. */
  readonly product: string;
  /** Human name for the report. */
  readonly label: string;
  /** The declared version or range, verbatim. */
  readonly declared: string;
  /** Repo-relative path of the file that declared it. */
  readonly source: string;
};

export type RepoInspection = {
  /** Absolute, resolved path of the checkout. */
  readonly root: string;
  /** Repo-relative lockfile paths, sorted. */
  readonly lockfiles: readonly string[];
  readonly manifestName: string | undefined;
  readonly directDependencies: readonly DirectDependency[];
  readonly runtimes: readonly RuntimeDeclaration[];
  /** Limits worth reporting: an unreadable manifest, a truncated walk, … */
  readonly notes: readonly string[];
};

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text();
  } catch {
    return undefined;
  }
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }

  const out: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') {
      out[key] = entry;
    }
  }

  return out;
}

/** Depth-bounded walk for lockfiles. Returns repo-relative paths, sorted. */
async function findLockfiles(root: string): Promise<{
  readonly paths: readonly string[];
  readonly truncated: boolean;
}> {
  const wanted = new Set(LOCKFILE_NAMES);
  const found: string[] = [];
  let queue: readonly string[] = [''];

  for (let depth = 0; depth <= MAX_DEPTH && queue.length > 0; depth += 1) {
    const next: string[] = [];

    for (const relative of queue) {
      const entries = await readdir(join(root, relative), { withFileTypes: true }).catch(
        () => undefined,
      );

      if (entries === undefined) {
        continue;
      }

      for (const entry of entries) {
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`;

        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
            next.push(child);
          }
          continue;
        }

        if (wanted.has(entry.name)) {
          found.push(child);
        }
      }
    }

    queue = next;
  }

  const sorted = found.sort();

  return {
    paths: sorted.slice(0, MAX_LOCKFILES),
    truncated: sorted.length > MAX_LOCKFILES,
  };
}

/**
 * Which endoflife.date product a direct dependency stands for.
 *
 * Deliberately short. Every entry is a product slug verified to exist on
 * endoflife.date, and a framework only earns a place here when running an
 * out-of-support major is a real security exposure rather than a style choice.
 */
const FRAMEWORK_PRODUCTS: Readonly<Record<string, { product: string; label: string }>> = {
  next: { product: 'nextjs', label: 'Next.js' },
  nuxt: { product: 'nuxt', label: 'Nuxt' },
  '@angular/core': { product: 'angular', label: 'Angular' },
  vue: { product: 'vue', label: 'Vue' },
};

function runtimesFromManifest(
  manifest: Record<string, unknown>,
  source: string,
  direct: readonly DirectDependency[],
): readonly RuntimeDeclaration[] {
  const engines = stringRecord(manifest.engines);
  const out: RuntimeDeclaration[] = [];

  if (engines.node !== undefined) {
    out.push({ product: 'nodejs', label: 'Node.js', declared: engines.node, source });
  }

  if (engines.bun !== undefined) {
    out.push({ product: 'bun', label: 'Bun', declared: engines.bun, source });
  }

  for (const dependency of direct) {
    const framework = FRAMEWORK_PRODUCTS[dependency.name];

    if (framework !== undefined) {
      out.push({ ...framework, declared: dependency.range, source });
    }
  }

  return out;
}

/** One version-pinning file per line, e.g. `.nvmrc` holding `20.11.1`. */
const VERSION_FILES: readonly {
  readonly file: string;
  readonly product: string;
  readonly label: string;
}[] = [
  { file: '.nvmrc', product: 'nodejs', label: 'Node.js' },
  { file: '.node-version', product: 'nodejs', label: 'Node.js' },
  { file: '.bun-version', product: 'bun', label: 'Bun' },
  { file: '.python-version', product: 'python', label: 'Python' },
  { file: '.ruby-version', product: 'ruby', label: 'Ruby' },
];

async function runtimesFromVersionFiles(root: string): Promise<readonly RuntimeDeclaration[]> {
  const out: RuntimeDeclaration[] = [];

  for (const candidate of VERSION_FILES) {
    const text = await readTextFile(join(root, candidate.file));
    const declared = text?.split('\n')[0]?.trim();

    if (declared !== undefined && declared !== '') {
      out.push({
        product: candidate.product,
        label: candidate.label,
        declared,
        source: candidate.file,
      });
    }
  }

  return out;
}

async function runtimesFromComposer(root: string): Promise<readonly RuntimeDeclaration[]> {
  const text = await readTextFile(join(root, 'composer.json'));
  const php = text === undefined ? undefined : stringRecord(parseJsonObject(text)?.require).php;

  return php === undefined
    ? []
    : [{ product: 'php', label: 'PHP', declared: php, source: 'composer.json' }];
}

/** Keeps one declaration per product: the first one wins, sources stay sorted. */
function dedupeRuntimes(
  declarations: readonly RuntimeDeclaration[],
): readonly RuntimeDeclaration[] {
  const seen = new Map<string, RuntimeDeclaration>();

  for (const declaration of declarations) {
    if (!seen.has(declaration.product)) {
      seen.set(declaration.product, declaration);
    }
  }

  return [...seen.values()].sort((left, right) => (left.product < right.product ? -1 : 1));
}

function directDependenciesOf(manifest: Record<string, unknown>): readonly DirectDependency[] {
  const production = stringRecord(manifest.dependencies);
  const development = stringRecord(manifest.devDependencies);

  const entries: DirectDependency[] = [
    ...Object.entries(production).map(([name, range]) => ({ name, range, dev: false })),
    ...Object.entries(development).map(([name, range]) => ({ name, range, dev: true })),
  ];

  return entries.sort((left, right) => (left.name < right.name ? -1 : 1));
}

/** Rejects a path that is not a readable directory, with a message worth reading. */
export async function requireDirectory(path: string): Promise<string> {
  const root = isAbsolute(path) ? path : resolve(process.cwd(), path);

  try {
    const info = await stat(root);

    if (!info.isDirectory()) {
      throw new Error(`--repo ${path} is not a directory.`);
    }
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('--repo ')) {
      throw cause;
    }
    throw new Error(`--repo ${path} could not be read as a directory.`);
  }

  return root;
}

export async function inspectRepo(path: string): Promise<RepoInspection> {
  const root = await requireDirectory(path);
  const notes: string[] = [];

  const { paths: lockfiles, truncated } = await findLockfiles(root);

  if (truncated) {
    notes.push(
      `El repo declara más de ${MAX_LOCKFILES} lockfiles; se listan los primeros ${MAX_LOCKFILES}. El escaneo de vulnerabilidades sigue cubriendo el árbol completo.`,
    );
  }

  const manifestText = await readTextFile(join(root, 'package.json'));
  const manifest = manifestText === undefined ? undefined : parseJsonObject(manifestText);

  if (manifestText !== undefined && manifest === undefined) {
    notes.push(
      'package.json existe pero no es JSON válido: no se pudieron leer las dependencias directas ni los runtimes declarados ahí.',
    );
  }

  const directDependencies = manifest === undefined ? [] : directDependenciesOf(manifest);
  const manifestName =
    typeof manifest?.name === 'string' && manifest.name !== '' ? manifest.name : undefined;

  const runtimes = dedupeRuntimes([
    ...(manifest === undefined
      ? []
      : runtimesFromManifest(manifest, 'package.json', directDependencies)),
    ...(await runtimesFromVersionFiles(root)),
    ...(await runtimesFromComposer(root)),
  ]);

  if (lockfiles.length === 0) {
    notes.push(
      'No se encontró ningún lockfile en el repo: sin versiones exactas, el análisis de dependencias no puede ser white-box.',
    );
  }

  return { root, lockfiles, manifestName, directDependencies, runtimes, notes };
}
