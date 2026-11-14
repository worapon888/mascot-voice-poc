import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

function resolveWithExtensions(candidatePath) {
  const extensions = [
    '',
    '.ts',
    '.tsx',
    '.js',
    '.mjs',
    '/index.ts',
    '/index.js',
  ];
  for (const ext of extensions) {
    const full = candidatePath + ext;
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return pathToFileURL(full).href;
    }
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const target = path.join(projectRoot, 'src', specifier.slice(2));
      const resolved = resolveWithExtensions(target);
      if (resolved) {
        return { url: resolved, shortCircuit: true };
      }
    } else if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      context.parentURL
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const target = path.resolve(parentDir, specifier);
      const resolved = resolveWithExtensions(target);
      if (resolved) {
        return { url: resolved, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
