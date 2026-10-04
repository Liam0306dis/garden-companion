import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BundleCatalogs } from './bundle-catalogs.js';

/** The public repo's root, whichever build script imports this. */
const root = resolve(import.meta.dirname, '..');

/**
 * Builds the sprite loader: the page script that fetches the atlases, starts the sprite worker and
 * draws the pets. It runs in the page, so it is built on its own and injected as source.
 *
 * The Basis transcoder's JS glue is bundled from npm; its wasm is downloaded at run time, so the
 * build records the hash of the installed copy and the loader refuses any download that does not
 * match it. The glue's Node branch reaches for fs, which never runs in a browser, so fs is external.
 */
export async function buildSpriteLoader(catalogs: BundleCatalogs, options: { withoutSprites?: boolean } = {}): Promise<string> {
  if (options.withoutSprites) return 'console.warn("[Garden Companion] Built with --no-sprites: artwork is disabled.");';
  const basisWasm = await readFile(resolve(root, 'node_modules', '@h00w', 'basis-universal-transcoder', 'dist', 'basis_capi_transcoder.wasm'));
  const shared = {
    bundle: true,
    format: 'iife' as const,
    platform: 'browser' as const,
    target: ['es2022'],
    charset: 'utf8' as const,
    legalComments: 'none' as const,
    write: false as const,
    external: ['fs'],
  };
  // The worker the loader starts to transcode, cut and encode off the main thread. Built first and
  // carried inside the loader as source.
  const worker = await build({ ...shared, entryPoints: [resolve(root, 'src', 'sprite-worker.ts')] });
  const loader = await build({
    ...shared,
    entryPoints: [resolve(root, 'src', 'pet-sprites-page.ts')],
    define: {
      __PET_CATALOG__: JSON.stringify(catalogs.pets),
      __PLANT_CATALOG__: JSON.stringify(catalogs.plants),
      __DECOR_CATALOG__: JSON.stringify(catalogs.decor),
      __MUTATION_CATALOG__: JSON.stringify(catalogs.mutations),
      __BASIS_WASM_SHA256__: JSON.stringify(createHash('sha256').update(basisWasm).digest('base64')),
      __SPRITE_WORKER__: JSON.stringify(worker.outputFiles[0].text),
    },
  });
  return loader.outputFiles[0].text;
}
