import typescript from '@rollup/plugin-typescript';

export default {
    // Multiple entry points so subpath exports (e.g. `ernesto/dashboards`)
    // emit their own `dist/<sub>/index.{js,cjs}` files. Without listing the
    // sub-entry, Rollup tree-shakes the barrel and re-hoists its exports
    // into `dist/index.js` only — package consumers asking for
    // `ernesto/dashboards` then fail to resolve.
    input: [
        'src/index.ts',
        'src/dashboards/index.ts',
        'src/harness/index.ts',
        'src/harness/cas/index.ts',
        'src/harness/cursor/index.ts',
        'src/harness/fragua-pi/index.ts',
        'src/harness/mock/index.ts',
        'src/workflows/index.ts',
        'src/workflow-engine/index.ts',
        'src/components/index.ts',
        'src/ui-tools/index.ts',
    ],
    // The CAS / Cursor / fragua-pi adapters import their respective SDK
    // packages; all are optional peer deps, so Rollup must not try to
    // bundle them. The MCP synthesis layer additionally imports specific
    // subpaths of `@modelcontextprotocol/sdk` (server/mcp.js,
    // server/streamableHttp.js) — those must also be external since
    // the SDK is a peer dep. The fragua-pi adapter pulls
    // `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`; pi-ai
    // also has a `typebox` runtime dep that we route through the
    // bundler boundary as external.
    external: (id) => {
        if (id === '@anthropic-ai/claude-agent-sdk') return true;
        if (id === '@cursor/sdk') return true;
        if (id === 'zod') return true;
        if (id.startsWith('@modelcontextprotocol/sdk')) return true;
        if (id === '@mariozechner/pi-agent-core') return true;
        if (id.startsWith('@mariozechner/pi-agent-core/')) return true;
        if (id === '@mariozechner/pi-ai') return true;
        if (id.startsWith('@mariozechner/pi-ai/')) return true;
        if (id === 'typebox') return true;
        return false;
    },
    output: [
        {
            dir: 'dist',
            format: 'cjs',
            preserveModules: true,
            sourcemap: true,
            entryFileNames: '[name].cjs',
        },
        {
            dir: 'dist',
            format: 'module',
            preserveModules: true,
            sourcemap: true,
            entryFileNames: '[name].js',
        },
    ],
    plugins: [
        typescript({
            compilerOptions: {
                rootDir: 'src',
                declarationDir: 'dist',
            },
        }),
    ],
};
