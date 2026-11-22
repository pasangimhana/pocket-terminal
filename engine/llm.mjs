// Streaming chat calls to an OpenAI-compatible provider. Provider is picked with PT_PROVIDER.
// Keys come only from the environment (engine/env.mjs loads the repo .env and POCKET_EXTRA_ENV files).
//   cerebras (default)  Kimi K3.1 Pro on Cerebras, key CEREBRAS_API_KEY
//   deepseek            DeepSeek API (thinking disabled), key DEEPSEEK_API_KEY
//   openrouter          Kimi K3.1 Pro on GPU hosts via OpenRouter, key OPENROUTER_API_KEY (legacy name OPENROUTER_KEY)
import './env.mjs';

export function providerConfig(override) {
  const name = override || process.env.PT_PROVIDER || 'cerebras';
  if (name === 'cerebras') {
    return {
      name, label: 'Kimi K3.1 Pro · Cerebras', base: 'https://api.cerebras.ai/v1',
      model: process.env.PT_MODEL || 'moonshotai-kimi-k3.1-pro-trial', key: process.env.CEREBRAS_API_KEY,
      extra: { reasoning_effort: process.env.PT_EFFORT || 'low' }, headers: {},
    };
  }
  if (name === 'deepseek') {
    return {
      name, label: `${process.env.PT_MODEL || 'deepseek-flash'} · DeepSeek (test)`, base: 'https://api.deepseek.com/v1', model: process.env.PT_MODEL || 'deepseek-flash',
      // Thinking off: with it on, an agent can spend its whole max_tokens reasoning and emit no lines.
      key: process.env.DEEPSEEK_API_KEY, extra: { thinking: { type: 'disabled' } }, headers: {},
    };
  }
  if (name === 'openrouter') {
    // Kimi K3.1 Pro on NVIDIA GPU hosts via OpenRouter (GPU-side benchmark), fastest host first
    return {
      name, label: 'Kimi K3.1 Pro · GPU (OpenRouter)', base: 'https://openrouter.ai/api/v1', model: process.env.PT_MODEL || 'moonshotai/kimi-k3.1-pro',
      key: process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY, extra: { reasoning: { effort: 'low' }, provider: { sort: 'throughput' } }, headers: { 'X-Title': 'pocket-terminal' },
    };
  }
  throw new Error('Unknown PT_PROVIDER ' + name);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Stream one chat call. Callbacks: onQueued(attempt, status), onFirst(t), onText(deltaText, kind), returns { content, usage, timeInfo }.
export async function streamChat({ messages, maxTokens = 2500, sessionId, signal, onRetry, onFirst, onText, retryForMs = 6 * 60e3, provider }) {
  const cfg = providerConfig(provider);
  if (!cfg.key) throw new Error(`No API key for provider ${cfg.name}`);
  const body = { model: cfg.model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens, temperature: 0.3, ...cfg.extra };
  const headers = { Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json', ...cfg.headers };
  const start = Date.now();
  let attempt = 0, r;
  for (;;) {
    attempt++;
    try {
      r = await fetch(cfg.base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      r = { ok: false, status: 0, text: async () => String(e) };
    }
    if (r.ok) break;
    const txt = (await r.text()).slice(0, 300);
    const retriable = r.status === 0 || r.status === 429 || r.status >= 500;
    if (!retriable || Date.now() - start > retryForMs) throw new Error(`HTTP ${r.status}: ${txt}`);
    onRetry?.(attempt, r.status, txt);
    await sleep(Math.min(6000, 1500 + 500 * attempt) + Math.random() * 800);
  }
  const dec = new TextDecoder();
  let buf = '', content = '', usage = null, timeInfo = null, first = 0;
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim();
      if (p === '[DONE]') continue;
      let j; try { j = JSON.parse(p); } catch { continue; }
      if (j.usage) usage = j.usage;
      if (j.time_info) timeInfo = j.time_info;
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      const reasoning = d.reasoning || d.reasoning_content;
      if ((d.content || reasoning) && !first) { first = Date.now(); onFirst?.(first); }
      if (reasoning) onText?.(reasoning, 'reasoning');
      if (d.content) { content += d.content; onText?.(d.content, 'content'); }
    }
  }
  return { content, usage, timeInfo, first, end: Date.now(), attempts: attempt };
}
