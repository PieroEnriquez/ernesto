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
        'src/harness/mock/index.ts',
    ],
    // The CAS adapter imports `@anthropic-ai/claude-agent-sdk`; it's an
    // optional peer dep, so Rollup must not try to bundle it.
    external: ['@anthropic-ai/claude-agent-sdk'],
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
