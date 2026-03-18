import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // 'vscode' must stay external (provided by VS Code at runtime).
  // Node built-ins are automatically kept external by platform:'node'.
  // Everything else (including @modelcontextprotocol/sdk) IS bundled.
  external: ['vscode'],
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
  console.log('[esbuild] Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log('[esbuild] Extension built successfully.');
}
