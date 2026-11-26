import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { toolPackageImport } from '../content/package-name.js';

/**
 * Content modules live outside the compiled tool and keep standard NodeNext
 * `./foo.js` specifiers that actually point at `foo.ts`. Node's built-in type
 * stripping loads `.ts` files but does not remap the extension, so this hook
 * retries relative imports. It also lets a standalone CLI load content that
 * has no local BEWright install of its own.
 */
export function registerContentResolution() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const toolImport = toolPackageImport(specifier);
      // Existing content uses the old name, which now identifies a different npm package.
      if (toolImport && toolImport !== specifier)
        return nextResolve(toolImport, { ...context, parentURL: import.meta.url });
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error;
        if (toolImport) return nextResolve(toolImport, { ...context, parentURL: import.meta.url });
        if (!context.parentURL || !/^\.{1,2}\//.test(specifier)) throw error;
        const extension = specifier.endsWith('.mjs') ? '.mts' : specifier.endsWith('.js') ? '.ts' : undefined;
        if (!extension) throw error;
        const candidate = new URL(specifier.slice(0, -extension.length) + extension, context.parentURL);
        if (candidate.protocol !== 'file:' || !existsSync(fileURLToPath(candidate))) throw error;
        return nextResolve(candidate.href, context);
      }
    },
  });
}
