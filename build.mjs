// 中间层打包成单文件 server/dist/server.js（无运行时依赖）。
import { build } from 'esbuild';
import path from 'node:path';

const root = import.meta.dirname;
await build({ entryPoints: [path.join(root, 'src/index.ts')], outfile: path.join(root, 'dist/server.js'), bundle: true, platform: 'node', target: 'node20', format: 'cjs', sourcemap: true, logLevel: 'warning' });
console.log('server built');
