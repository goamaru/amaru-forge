import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';

mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/js/app.js'],
  bundle: true,
  outfile: 'dist/bundle.js',
  format: 'esm',
  minify: process.argv.includes('--minify'),
  external: [],
});

copyFileSync('src/index.html', 'dist/index.html');
copyFileSync('src/css/styles.css', 'dist/styles.css');
