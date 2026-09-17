// Chain Life 本地服务器
// - 静态托管 index.html
// - /rpc 代理 → Arbitrum One 公共 RPC（浏览器直连有 CORS 限制）
// - /bio 代理 → DeepSeek AI 钱包生平（复用 workers/worker.js 的 prompt）
// - /gmx 代理 → GMX 官方 squid GraphQL（捕猎记录）
// 启动: node server.js  →  http://127.0.0.1:8787

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RPC_URL = 'https://arbitrum-one-rpc.publicnode.com';
const GMX_URL = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const PORT = 8787;

function deepseekKey() {
  try {
    const env = fs.readFileSync(path.join(os.homedir(), '.config/deepseek-claude/env'), 'utf8');
    return env.match(/DEEPSEEK_API_KEY="([^"]+)"/)?.[1] || null;
  } catch {
    return null;
  }
}

// 每次请求实时读 index.html，改前端代码无需重启服务器
function readHtml() {
  return fs.readFileSync(__dirname + '/index.html', 'utf-8');
}

async function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

async function proxyJson(res, url, body, headers = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const rr = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
    signal: controller.signal
  });
  clearTimeout(timer);
  const data = await rr.text();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(data);
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const body = await readBody(req);

  try {
    if (req.url === '/rpc' && req.method === 'POST') {
      await proxyJson(res, RPC_URL, body);
      return;
    }

    if (req.url === '/gmx' && req.method === 'POST') {
      await proxyJson(res, GMX_URL, body, {}, 12000);
      return;
    }

    if (req.url === '/bio' && req.method === 'POST') {
      const key = deepseekKey();
      if (!key) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'DEEPSEEK_API_KEY not found in ~/.config/deepseek-claude/env' }));
        return;
      }
      const { address, facts, lang } = JSON.parse(body);
      const { buildBioPrompt } = await import('./workers/worker.js');
      const rr = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: buildBioPrompt(facts, lang || 'en'),
          response_format: { type: 'json_object' },
          temperature: 0.9,
          max_tokens: 600
        })
      });
      if (!rr.ok) {
        res.writeHead(rr.status);
        res.end(JSON.stringify({ error: 'deepseek ' + rr.status }));
        return;
      }
      const data = await rr.json();
      const content = data.choices?.[0]?.message?.content;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ bio: JSON.parse(content), tokens: data.usage }));
      return;
    }

    // v4 视觉实验版：吸积盘 + 银河背景 + 透镜扭曲
    if (req.url && req.url.startsWith('/v4')) {
      const html4 = fs.readFileSync(__dirname + '/index-v4.html', 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html4);
      return;
    }

    const html = readHtml(); // 先读文件再写头，避免文件异常时双重写头
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: e.message }));
    } else {
      res.end();
    }
  }
}).listen(PORT, () => console.log('http://127.0.0.1:' + PORT));
