import { build } from 'esbuild';
import fs from 'fs';
const r = await build({ entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'iife', write: false, target: 'es2022', legalComments: 'none' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = fs.readFileSync('src/index.html', 'utf8').replace('<!--APP-->', () => `<script>${js}</script>`);
fs.writeFileSync('dist/index.html', html);
console.log('built', (html.length / 1024).toFixed(0) + ' KB');
