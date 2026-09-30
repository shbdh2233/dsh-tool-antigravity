import type { UserConfig } from 'tsdown'

export function clientBundle(packageName: string): UserConfig {
  return {
    entry: {
      client: 'src/client/index.ts',
    },
    format: ['cjs'],
    outDir: 'lib',
    clean: false,
    banner: `var __defLoader__ = (typeof window !== "undefined" && window.__ModuleLoader__) ? window.__ModuleLoader__.load.bind(window.__ModuleLoader__) : function(m) { Object.assign(module.exports, m.factory(require)); };\n__defLoader__({ id: "${packageName}", factory: function(require) {\nvar module = { exports: {} };\nvar exports = module.exports;\n`,
    footer: '\nreturn module.exports;\n}});\n',
  }
}
