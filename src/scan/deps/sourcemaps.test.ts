import { describe, expect, test } from 'bun:test';
import type { JsAsset } from './assets.ts';
import {
  conventionalMapUrl,
  extractSourceMappingUrl,
  type Fetcher,
  findExposedSourcemaps,
  readSourcemapPayload,
} from './sourcemaps.ts';
import { withWorkspace } from './workspace.ts';

const MAP = JSON.stringify({
  version: 3,
  sources: ['src/app.ts', 'src/api.ts'],
  sourcesContent: ['export const a = 1', 'export const b = 2'],
  mappings: 'AAAA',
});

describe('extractSourceMappingUrl', () => {
  test('reads the comment builders emit', () => {
    expect(extractSourceMappingUrl('window.x=1\n//# sourceMappingURL=app.js.map\n')).toBe(
      'app.js.map',
    );
  });

  test('reads the block-comment form and drops its terminator', () => {
    expect(extractSourceMappingUrl('window.x=1\n/*# sourceMappingURL=app.js.map */')).toBe(
      'app.js.map',
    );
  });

  test('takes the last one, which is the one the browser honours', () => {
    const concatenated =
      '//# sourceMappingURL=a.js.map\n;window.y=2\n//# sourceMappingURL=b.js.map';

    expect(extractSourceMappingUrl(concatenated)).toBe('b.js.map');
  });

  test('finds nothing in a bundle that declares nothing', () => {
    expect(extractSourceMappingUrl('window.x=1')).toBeUndefined();
  });
});

describe('readSourcemapPayload', () => {
  test('accepts a v3 map and counts what it reveals', () => {
    expect(readSourcemapPayload(MAP)).toEqual({ sources: 2, sourcesContent: true });
  });

  test('refuses the HTML an SPA host answers 200 with', () => {
    expect(
      readSourcemapPayload('<!doctype html><html><body>Not found</body></html>'),
    ).toBeUndefined();
  });

  test('refuses JSON that is not a source map', () => {
    expect(readSourcemapPayload('{"ok":true}')).toBeUndefined();
  });
});

describe('conventionalMapUrl', () => {
  test('drops the cache-busting query the map does not have', () => {
    expect(conventionalMapUrl('https://x.test/a/app.js?v=3#f')).toBe('https://x.test/a/app.js.map');
  });
});

async function assetWith(content: string, directory: string, url: string): Promise<JsAsset> {
  const path = `${directory}/${url.split('/').pop() ?? 'app.js'}`;
  await Bun.write(path, content);

  return { url, path, file: path, bytes: content.length, status: 200, thirdParty: false };
}

function fetcherFor(
  responses: Readonly<Record<string, { status: number; body: string }>>,
): Fetcher {
  return (url) => Promise.resolve(responses[url] ?? { status: 404, body: 'not found' });
}

describe('findExposedSourcemaps', () => {
  test('reports a declared map that really downloads', async () => {
    await withWorkspace(async (workspace) => {
      const asset = await assetWith(
        'window.x=1\n//# sourceMappingURL=app.js.map',
        workspace.directory,
        'https://x.test/assets/app.js',
      );

      const found = await findExposedSourcemaps(
        [asset],
        fetcherFor({ 'https://x.test/assets/app.js.map': { status: 200, body: MAP } }),
      );

      expect(found).toEqual([
        {
          asset: 'https://x.test/assets/app.js',
          url: 'https://x.test/assets/app.js.map',
          kind: 'linked',
          status: 200,
          sources: 2,
          sourcesContent: true,
        },
      ]);
    });
  });

  test('a declared map that 404s is not an exposure', async () => {
    await withWorkspace(async (workspace) => {
      const asset = await assetWith(
        'window.x=1\n//# sourceMappingURL=app.js.map',
        workspace.directory,
        'https://x.test/assets/app.js',
      );

      expect(await findExposedSourcemaps([asset], fetcherFor({}))).toEqual([]);
    });
  });

  test('a 200 that is really the SPA shell is not an exposure either', async () => {
    await withWorkspace(async (workspace) => {
      const asset = await assetWith(
        'window.x=1\n//# sourceMappingURL=app.js.map',
        workspace.directory,
        'https://x.test/assets/app.js',
      );

      const found = await findExposedSourcemaps(
        [asset],
        fetcherFor({
          'https://x.test/assets/app.js.map': { status: 200, body: '<!doctype html><html></html>' },
        }),
      );

      expect(found).toEqual([]);
    });
  });

  test('finds the map a build stripped the comment for but still ships', async () => {
    await withWorkspace(async (workspace) => {
      const asset = await assetWith(
        'window.x=1',
        workspace.directory,
        'https://x.test/assets/app.js',
      );

      const found = await findExposedSourcemaps(
        [asset],
        fetcherFor({ 'https://x.test/assets/app.js.map': { status: 200, body: MAP } }),
      );

      expect(found.map((entry) => entry.kind)).toEqual(['conventional']);
    });
  });

  test('reads an inline map without asking the network for anything', async () => {
    await withWorkspace(async (workspace) => {
      const inline = Buffer.from(MAP, 'utf8').toString('base64');
      const asset = await assetWith(
        `window.x=1\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${inline}`,
        workspace.directory,
        'https://x.test/assets/app.js',
      );

      const found = await findExposedSourcemaps([asset], () => {
        throw new Error('the network must not be touched for an inline map');
      });

      expect(found).toEqual([
        {
          asset: 'https://x.test/assets/app.js',
          url: 'inline',
          kind: 'inline',
          status: 200,
          sources: 2,
          sourcesContent: true,
        },
      ]);
    });
  });

  test('a network failure narrows the answer instead of ending the probe', async () => {
    await withWorkspace(async (workspace) => {
      const asset = await assetWith(
        'window.x=1\n//# sourceMappingURL=app.js.map',
        workspace.directory,
        'https://x.test/assets/app.js',
      );

      const found = await findExposedSourcemaps([asset], () =>
        Promise.reject(new Error('ECONNREFUSED')),
      );

      expect(found).toEqual([]);
    });
  });
});
