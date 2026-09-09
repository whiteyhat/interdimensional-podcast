import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const server = await createServer({
  configFile: false, root: process.cwd(),
  resolve: { alias: [
    { find: '@/lib/launch/artifact.mjs', replacement: `${process.cwd()}/tests/browser/launch-artifact.mjs` },
    { find: '@', replacement: process.cwd() },
  ] },
  plugins: [react(), nodePolyfills({ include: ['buffer'], globals: { Buffer: true, global: false, process: false } })],
  server: { host: '127.0.0.1', port: 3315, strictPort: true, hmr: false },
  css: { postcss: { plugins: [] } },
});
await server.listen();
console.log('http://127.0.0.1:3315/tests/browser/launch-sign.html');
