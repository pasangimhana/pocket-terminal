// Record a replay of a saved run to MP4 at 1920x1080, using real Chrome (headless) and CDP screencast frames.
// Needs Playwright (`npm install`), Google Chrome and ffmpeg. A server must be running (node server.mjs).
// Usage: node record/record.mjs <run-file.json> [out.mp4] [--base http://127.0.0.1:4790/] [--extra "&card=3500"] [--hold 6000]
// PLAYWRIGHT_DIR=/path/to/a/project/with/playwright uses a Playwright install from somewhere else.
import { createRequire } from 'node:module';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const require = createRequire(process.env.PLAYWRIGHT_DIR ? path.resolve(process.env.PLAYWRIGHT_DIR, 'package.json') : import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.error('Playwright not found: run `npm install` (or set PLAYWRIGHT_DIR)'); process.exit(1); }

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const run = args[0];
if (!run) { console.error('usage: node record/record.mjs <run-file.json> [out.mp4]'); process.exit(2); }
const out = path.resolve(args[1] && !args[1].startsWith('--') ? args[1] : `record/${run.replace(/\.json$/, '')}.mp4`);
const base = opt('--base', 'http://127.0.0.1:4790/');
const extra = opt('--extra', '&card=3500');
const hold = +opt('--hold', 6000);
const W = 1920, H = 1080;

const frames = path.join(path.dirname(out), '.frames-' + Date.now());
await mkdir(frames, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
const SCALE = +opt('--scale', 1.333); // render the UI larger so text reads on a phone
const page = await browser.newPage({ viewport: { width: Math.round(W / SCALE), height: Math.round(H / SCALE) }, deviceScaleFactor: SCALE });
const cdp = await page.context().newCDPSession(page);
const list = [];
cdp.on('Page.screencastFrame', async f => {
  const n = list.length;
  const file = path.join(frames, String(n).padStart(6, '0') + '.jpg');
  list.push({ file, t: f.metadata.timestamp });
  writeFile(file, Buffer.from(f.data, 'base64')).catch(() => {});
  cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
const url = opt('--url', null) || `${base}?replay=${encodeURIComponent(run)}${extra}`;
const duration = +opt('--duration', 0);
console.log('recording', url);
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(400);
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
const t0 = Date.now();
if (duration) await page.waitForTimeout(duration);
else { await page.waitForFunction(() => window.__replayDone, null, { timeout: 180000, polling: 250 }); await page.waitForTimeout(hold); }
await cdp.send('Page.stopScreencast');
await page.waitForTimeout(300);
await browser.close();
console.log(`${list.length} frames over ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// concat with real frame durations, then encode at constant 30 fps
let txt = '';
for (let i = 0; i < list.length; i++) {
  const d = i + 1 < list.length ? Math.max(0.001, list[i + 1].t - list[i].t) : 0.5;
  txt += `file '${list[i].file}'\nduration ${d.toFixed(4)}\n`;
}
txt += `file '${list[list.length - 1].file}'\n`;
const listFile = path.join(frames, 'list.txt');
await writeFile(listFile, txt);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', out], { stdio: 'inherit' });
await rm(frames, { recursive: true, force: true });
console.log('wrote', out);
