// Chain Life — Cloudflare Worker
// Routes:
//   GET  /               health
//   POST /bio            AI wallet biography (DeepSeek + KV cache)  body: {address, facts, lang}
//   POST /lb             submit a lifeform to the leaderboard       body: {address, energy, stage, archetype}
//   GET  /lb             top lifeforms (desc energy)
//   GET  /lb/:address    one lifeform
//   GET  /score/:address 钱包身份评分 JSON API（徽章/女巫筛查数据源）
//   GET  /badge/:address 可嵌入的身份徽章 HTML 卡片
// Deploy: `wrangler deploy` after `wrangler secret put DEEPSEEK_API_KEY` and creating KV binding CHAINLIFE_KV

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';
const LB_PREFIX = 'lb:';
const LB_KEEP = 100; // prune leaderboard beyond this size

// ---- 身份引擎：与前端 createConfig 同款公式（余额×400 + 交易数 → 阶段/评分）----
const ALCHEMY_KEY = 'alch_9iKrEXhhAmZ97F0hKHH9G'; // 免费层公开 key（与前端一致）
const ALCHEMY_RPC = 'https://arb-mainnet.g.alchemy.com/v2/' + ALCHEMY_KEY;
const ID_STAGES = ['Primordial','Emerged','Awakening','Growing','Thriving','Mature','Intense','Radiant','Ancient'];
const ID_THRESHOLDS = [0, 10, 50, 150, 400, 1000, 2500, 5000, 8000];
const ID_HUES = [0.60, 0.55, 0.48, 0.40, 0.25, 0.14, 0.07, 0.02, 0.95];
const SATOSHI_ADDR = '1a1zp1ep5qgefi2dmptftl5slmv7divfna';

export async function walletIdentity(address) {
  // 中本聪创世彩蛋（与前端一致）
  if (address.toLowerCase() === SATOSHI_ADDR) {
    return {
      address, energy: 99999, stage: 8, stageName: 'Ancient',
      vitality: 99, balanceEth: 0, txCount: 99999, isContract: false,
      wealth: 99, footprint: 99, wisdom: 99,
      archetype: '创世者 The Genesis', hue: 0.11, legend: true
    };
  }
  const body = JSON.stringify([
    { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] },
    { jsonrpc: '2.0', id: 2, method: 'eth_getTransactionCount', params: [address, 'latest'] },
    { jsonrpc: '2.0', id: 3, method: 'eth_getCode', params: [address, 'latest'] }
  ]);
  const res = await fetch(ALCHEMY_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  if (!res.ok) throw new Error('alchemy ' + res.status);
  const batch = await res.json();
  const byId = {};
  (batch || []).forEach((r) => { byId[r.id] = r.result; });

  const balanceEth = parseInt(byId[1] || '0x0', 16) / 1e18;
  const txCount = parseInt(byId[2] || '0x0', 16);
  const isContract = !!byId[3] && byId[3] !== '0x';
  const balanceBoost = Math.min(8000, Math.round(balanceEth * 400));
  const energy = balanceBoost + (isContract ? 0 : txCount);

  let stage = 0;
  for (let i = 8; i >= 0; i--) {
    if (energy >= ID_THRESHOLDS[i]) { stage = i; break; }
  }
  const vitality = Math.min(99, 55 +
    Math.round(Math.log10(1 + balanceEth) * 6 + (txCount > 0 ? 8 : 0) + (isContract ? 10 : 0)));
  const wealth = Math.min(99, Math.round(Math.log10(1 + balanceEth) * 18));
  const footprint = Math.min(99, Math.round(Math.log10(1 + (isContract ? 0 : txCount)) * 22));
  const wisdom = Math.min(99, Math.round((isContract ? 12 : 0) + (txCount > 200 ? 8 : 0)));

  const archetype = isContract
    ? (balanceEth >= 1000 ? '机构金库' : balanceEth >= 10 ? '协议中枢' : balanceEth > 0 ? '活跃合约' : '冷合约')
    : (energy >= 8000 ? '远古存在' : energy >= 2000 ? '巨鲸' : energy >= 500 ? '深度玩家'
      : energy >= 150 ? '活跃用户' : energy >= 50 ? '探索者' : energy >= 10 ? '初学者'
      : balanceEth > 0 ? '潜眠者' : '空白之卵');

  return {
    address, energy, stage, stageName: ID_STAGES[stage],
    vitality, balanceEth: Math.round(balanceEth * 10000) / 10000, txCount, isContract,
    wealth, footprint, wisdom, archetype, hue: ID_HUES[stage]
  };
}

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

      // 身份评分 JSON API（徽章/女巫筛查数据源）
      const scoreMatch = url.pathname.match(/^\/score\/(0x[0-9a-fA-F]{40}|[1-3][A-Za-z0-9]{25,34})$/);
      if (scoreMatch && request.method === 'GET') {
        const id = await walletIdentity(scoreMatch[1]);
        return cors(new Response(JSON.stringify({ ok: true, lifeform: id }), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' }
        }));
      }

      // 可嵌入身份徽章（iframe 卡片）
      const badgeMatch = url.pathname.match(/^\/badge\/(0x[0-9a-fA-F]{40}|[1-3][A-Za-z0-9]{25,34})$/);
      if (badgeMatch && request.method === 'GET') {
        const id = await walletIdentity(badgeMatch[1]);
        const hue = Math.round(id.hue * 360);
        const short = badgeMatch[1].slice(0, 6) + '…' + badgeMatch[1].slice(-4);
        const bar = (v, color) =>
          `<div style="display:flex;align-items:center;gap:6px;font-size:9px;color:rgba(255,255,255,.5);margin-top:3px;font-family:monospace;">
             <span style="width:34px;">${['WEA','FPT','VIT'][v] || ''}</span>
             <div style="flex:1;height:3px;border-radius:2px;background:rgba(255,255,255,.08);">
               <div style="height:100%;width:${color}%;border-radius:2px;background:hsl(${hue},85%,62%);"></div>
             </div><span>${color}</span></div>`;
        const html = `<!doctype html><html><head><meta charset="utf-8">
          <style>body{margin:0;display:flex;justify-content:center;background:transparent;font-family:-apple-system,'PingFang SC',sans-serif;}
          .card{display:flex;gap:10px;align-items:center;padding:8px 12px;border-radius:14px;
            background:rgba(8,10,18,.92);border:1px solid rgba(255,255,255,.1);
            box-shadow:0 4px 24px rgba(0,0,0,.4);}</style></head><body>
          <div class="card">
            <svg width="46" height="46" viewBox="0 0 100 100">
              <defs><radialGradient id="g" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="hsl(${hue},90%,88%)"/>
                <stop offset="40%" stop-color="hsl(${hue},85%,62%)"/>
                <stop offset="100%" stop-color="hsl(${hue},85%,30%)"/>
              </radialGradient></defs>
              <circle cx="50" cy="50" r="46" fill="url(#g)"/>
              <circle cx="50" cy="50" r="46" fill="none" stroke="hsl(${hue},90%,70%)" stroke-width="1.5" opacity=".7"/>
            </svg>
            <div>
              <div style="font-size:12px;color:#fff;font-weight:600;line-height:1.3;">${id.stageName} · E${id.energy}</div>
              <div style="font-size:9px;color:rgba(255,255,255,.45);margin-bottom:3px;">${id.archetype} · ${short}</div>
              ${bar(0, id.wealth)}${bar(1, id.footprint)}${bar(2, id.vitality)}
            </div>
          </div></body></html>`;
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' }
        });
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
