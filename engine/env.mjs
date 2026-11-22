// Loads keys from the repo's .env (or the file named by POCKET_ENV_FILE) into process.env.
// Values already set in the environment win. Nothing is printed.
// POCKET_EXTRA_ENV (colon-separated file paths, ~ allowed) names more env files to read afterwards,
// again only for names that are not set yet. Lets keys stay where they already live.
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_FILE = process.env.POCKET_ENV_FILE || path.join(ROOT, '.env');

export function loadEnv(file = ENV_FILE) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();
for (const f of (process.env.POCKET_EXTRA_ENV || '').split(':').map(x => x.trim()).filter(Boolean)) {
  loadEnv(f === '~' ? os.homedir() : f.startsWith('~/') ? path.join(os.homedir(), f.slice(2)) : f);
}

// For a feature that needs a key: returns null when the key is set, else an object the page shows.
export function needsKey(name) {
  return process.env[name] ? null : { error: `add ${name} to .env`, needsKey: name };
}
