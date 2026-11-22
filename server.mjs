// Standalone dev server: the same handler as the OpenClaw plugin, but /api/ask runs the session scripted
// (scan -> spawn -> expand top 12 by mentions) with bot events marked scripted: true.
import http from 'node:http';
import { handle } from './engine/http.mjs';

const port = +(process.env.PORT || 4790);
http.createServer((req, res) => handle(req, res, { prefix: '', mode: 'scripted' })).listen(port, '127.0.0.1', () => {
  console.log(`pocket-terminal (scripted) on http://127.0.0.1:${port}`);
});
