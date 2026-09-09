import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  resolve: { alias: { '@': process.cwd() } },
  plugins: [react()],
  server: { host: '127.0.0.1', port: 3314, strictPort: true, hmr: false },
  css: { postcss: { plugins: [] } },
});
await server.listen();
console.log('http://127.0.0.1:3314/tests/browser/player-handoff.html');
console.log(
  'Append ?fallback=1 to test browsers without video frame callbacks.',
);
