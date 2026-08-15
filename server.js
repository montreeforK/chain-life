// Chain Life 本地服务器
// - 静态托管 index.html
// - /rpc 代理 → Arbitrum One 公共 RPC（浏览器直连有 CORS 限制）
// 启动: node server.js  →  http://127.0.0.1:8787

const http = require('http');
const fs = require('fs');

const RPC_URL = 'https://arbitrum-one-rpc.publicnode.com';
const PORT = 8787;

// 每次请求实时读 index.html，改前端代码无需重启服务器
function readHtml() {
  return fs.readFileSync(__dirname + '/index.html', 'utf-8');
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/rpc' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const rr = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal
        });
        clearTimeout(timer);
        const data = await rr.text();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(data);
      } catch (e) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(readHtml());
}).listen(PORT, () => console.log('http://127.0.0.1:' + PORT));
