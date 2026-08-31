// 本地验证 AI 生平 prompt 质量（直连 DeepSeek，不走 Workers）
// 用法: node workers/test-bio.mjs [en|zh]
import { readFileSync } from 'node:fs';
import { buildBioPrompt } from './worker.js';

const lang = process.argv[2] || 'en';
const key = readFileSync(process.env.HOME + '/.config/deepseek-claude/env', 'utf8')
  .match(/DEEPSEEK_API_KEY="([^"]+)"/)?.[1];
if (!key) throw new Error('DEEPSEEK_API_KEY not found in ~/.config/deepseek-claude/env');

// —— mock facts（仅测 prompt，真实数据由前端从 Alchemy 拉取后传入）——
const facts = {
  address: '0x1234...5678',
  born: '2021-05-03',
  firstTx: 'Claimed a UNI airdrop',
  txCount: 4231,
  balanceEth: 2.3,
  biggestTx: '340 ETH transfer on 2023-03-15',
  holdings: ['GMX', 'ARB', 'LINK'],
  protocols: ['Uniswap', 'GMX', 'Aave'],
  archetype: 'Whale Core',
  stage: 7,
};

const res = await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model: 'deepseek-chat',
    messages: buildBioPrompt(facts, lang),
    response_format: { type: 'json_object' },
    temperature: 0.9,
    max_tokens: 600,
  }),
});
if (!res.ok) {
  console.error('HTTP', res.status, await res.text());
  process.exit(1);
}
const data = await res.json();
const content = data.choices[0].message.content;
console.log('raw:', content.slice(0, 80) + '...');
console.log('\nparsed:\n', JSON.stringify(JSON.parse(content), null, 2));
console.log('\ntokens:', data.usage);
