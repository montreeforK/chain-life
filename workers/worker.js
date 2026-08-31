// Chain Life — Cloudflare Worker
// Routes:
//   GET  /               health
//   POST /bio            AI wallet biography (DeepSeek + KV cache)  body: {address, facts, lang}
//   POST /lb             submit a lifeform to the leaderboard       body: {address, energy, stage, archetype}
//   GET  /lb             top lifeforms (desc energy)
//   GET  /lb/:address    one lifeform
// Deploy: `wrangler deploy` after `wrangler secret put DEEPSEEK_API_KEY` and creating KV binding CHAINLIFE_KV

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';
const LB_PREFIX = 'lb:';
const LB_KEEP = 100; // prune leaderboard beyond this size

// ---- pure helpers (importable by local test scripts) ----

export function buildBioPrompt(facts, lang) {
  const L = lang === 'zh' ? {
    sys: '你是一位链上生物传记作家。你只依据给定的事实写作，绝不编造数字、日期或事件。所有输出内容（name/traits/story/epitaph 全部字段）必须使用简体中文，即使输入的事实是英文。输出 JSON：{name, traits, story, epitaph}。name 是给这个链上生命起的名字（2-4 字，意象化）；traits 是 3 个性格词；story 是两段生平（每段 1-2 句，用区块链事实支撑，拟人化但不夸张）；epitaph 是一句墓志铭。',
    facts: '链上事实',
  } : {
    sys: 'You are an onchain biographer. Write ONLY from the given facts — never invent numbers, dates, or events. Output JSON: {name, traits, story, epitaph}. name: an evocative 2-4 word name for this onchain lifeform; traits: 3 personality words; story: two short paragraphs (1-2 sentences each) grounded in the facts, personified but not exaggerated; epitaph: a one-line epitaph.',
    facts: 'Onchain facts',
  };
  const f = facts;
  return [
    { role: 'system', content: L.sys },
    { role: 'user', content: `${L.facts}:\n${JSON.stringify(f, null, 1)}` },
  ];
}

// ---- DeepSeek call ----

async function callDeepSeek(env, facts, lang) {
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: buildBioPrompt(facts, lang),
      response_format: { type: 'json_object' },
      temperature: 0.9,
      max_tokens: 600,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek returned empty content');
  return JSON.parse(content);
}

// ---- leaderboard (KV, lexicographic-score pattern) ----

function lbKey(energy, address) {
  return `${LB_PREFIX}${String(Math.floor(energy)).padStart(20, '0')}:${address}`;
}

async function lbTop(env, n) {
  const list = await env.CHAINLIFE_KV.list({ prefix: LB_PREFIX });
  const keys = list.keys.map((k) => k.name).sort(); // ascending energy
  return keys.slice(-Math.min(n, keys.length)).reverse().map((k) => {
    const [energy, address] = k.slice(LB_PREFIX.length).split(':');
    return { address, energy: Number(energy) };
  });
}

async function lbUpsert(env, entry) {
  const existing = await env.CHAINLIFE_KV.list({ prefix: LB_PREFIX });
  for (const k of existing.keys) {
    if (k.name.endsWith(':' + entry.address)) {
      await env.CHAINLIFE_KV.delete(k.name);
      break;
    }
  }
  await env.CHAINLIFE_KV.put(lbKey(entry.energy, entry.address), JSON.stringify(entry));
  // prune tail
  const after = await env.CHAINLIFE_KV.list({ prefix: LB_PREFIX });
  const overflow = after.keys.length - LB_KEEP;
  if (overflow > 0) {
    const sorted = after.keys.map((k) => k.name).sort();
    for (const name of sorted.slice(0, overflow)) await env.CHAINLIFE_KV.delete(name);
  }
}

// ---- CORS + minimal rate limit ----

function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(res.body, { status: res.status, headers: h });
}

const rl = new Map(); // ip -> [windowStart, count]
function rateLimited(ip) {
  const now = Date.now();
  const w = rl.get(ip);
  if (!w || now - w[0] > 60_000) {
    rl.set(ip, [now, 1]);
    return false;
  }
  w[1]++;
  if (w[1] > 60) return true; // 60 req/min per ip
  return false;
}

// ---- router ----

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (request.method === 'GET' && url.pathname === '/') {
      return cors(new Response(JSON.stringify({ ok: true, service: 'chain-life' })));
    }
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    if (rateLimited(ip)) return cors(new Response('rate limited', { status: 429 }));

    try {
      // AI biography
      if (request.method === 'POST' && url.pathname === '/bio') {
        const { address, facts, lang } = await request.json();
        if (!address || !facts) return cors(new Response('address and facts required', { status: 400 }));
        const cacheKey = `bio:${address.toLowerCase()}:${lang || 'en'}`;
        const cached = await env.CHAINLIFE_KV.get(cacheKey, 'json');
        if (cached) return cors(new Response(JSON.stringify({ ...cached, cached: true })));
        const bio = await callDeepSeek(env, facts, lang || 'en');
        await env.CHAINLIFE_KV.put(cacheKey, JSON.stringify(bio), { expirationTtl: 30 * 86400 });
        return cors(new Response(JSON.stringify({ ...bio, cached: false })));
      }

      // leaderboard
      if (url.pathname === '/lb' && request.method === 'POST') {
        const entry = await request.json();
        if (!entry.address || typeof entry.energy !== 'number' || entry.energy < 0) {
          return cors(new Response('address and non-negative energy required', { status: 400 }));
        }
        await lbUpsert(env, { ...entry, ts: Date.now() });
        return cors(new Response(JSON.stringify({ ok: true })));
      }
      if (url.pathname === '/lb' && request.method === 'GET') {
        return cors(new Response(JSON.stringify({ top: await lbTop(env, 50) })));
      }
      if (url.pathname.startsWith('/lb/') && request.method === 'GET') {
        const address = url.pathname.slice(4).toLowerCase();
        const entries = (await lbTop(env, LB_KEEP)).filter((e) => e.address.toLowerCase() === address);
        return cors(new Response(JSON.stringify({ found: entries.length > 0, entries })));
      }

      return cors(new Response('not found', { status: 404 }));
    } catch (e) {
      return cors(new Response(JSON.stringify({ error: e.message }), { status: 500 }));
    }
  },
};
