// Living NFT 全流程测试：mint → feed(GMX) → 阶段进化 → syncStats → sync → 冷却防刷 → tokenURI
// 用法: node test-living.js
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const RPC_URL = 'https://sepolia-rollup.arbitrum.io/rpc';
const KEY_FILE = path.join(__dirname, 'deployer-key.json');

async function main() {
  const deployer = new ethers.Wallet(JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).privateKey);
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = deployer.connect(provider);

  // 每次运行用全新钱包铸造（一钱包一生命），feed/sync 由部署者代调用（验证"任何人可喂食"）
  const life = ethers.Wallet.createRandom().connect(provider);
  const fund = await signer.sendTransaction({ to: life.address, value: ethers.parseEther('0.0003') });
  await fund.wait();

  const { address, abi } = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployed.json'), 'utf8'));
  const nft = new ethers.Contract(address, abi, signer);
  const nftLife = nft.connect(life);
  console.log('合约:', address);
  console.log('新生命钱包:', life.address);

  const tokenId = ethers.solidityPackedKeccak256(['address'], [life.address]);
  const params = () => nft.lifeParams(tokenId);

  // 1. mint（由生命钱包本人铸造）
  const tx = await nftLife.mint(100, 120, 200, 255, 100, 4, 60);
  await tx.wait();
  let p = await params();
  const n = (v) => Number(v);
  console.log('\n1️⃣ mint 后:  stage=%d energy=%d tx=%d xp=%d', n(p.stage), n(p.energy), n(p.txCount), n(p.xp));
  if (n(p.stage) !== 4) throw new Error('mint stage 应为 4');

  // 2. feed(gmx-trade)：XP+100 → energy = tx100 + xp100*20 = 2100 → stage 5
  const tx2 = await nft.feed(tokenId, 'gmx-trade', 'arb1-tx-0xfeed');
  await tx2.wait();
  p = await params();
  console.log('2️⃣ GMX喂食后: stage=%d energy=%d xp=%d lastEvent=%s', n(p.stage), n(p.energy), n(p.xp), p.lastEvent);
  if (n(p.stage) !== 5 || n(p.xp) !== 100) throw new Error('feed 后 stage 应为 5, xp 应为 100');

  // 3. 冷却防刷：立即再次 feed 应 revert
  let reverted = false;
  try {
    await (await nft.feed(tokenId, 'swap', 'arb1-tx-0xspam')).wait();
  } catch (e) {
    reverted = /digesting/.test(e.message || '') || /digesting/.test(e.info?.error?.message || '');
  }
  console.log('3️⃣ 冷却防刷: %s', reverted ? '✅ 被拒绝(digesting)' : '❌ 未被拒绝!');
  if (!reverted) throw new Error('冷却未生效');

  // 4. syncStats：txCount 5000 → energy = 5000 + 2000 = 7000 → stage 7 (Radiant)
  const tx4 = await nft.syncStats(tokenId, 5000);
  await tx4.wait();
  p = await params();
  console.log('4️⃣ syncStats后: stage=%d energy=%d tx=%d vitality=%d', n(p.stage), n(p.energy), n(p.txCount), n(p.vitality));
  if (n(p.stage) !== 7) throw new Error('syncStats 后 stage 应为 7');

  // 5. sync：余额变化会实时反映（部署钱包余额≈0.0015 ETH，boost=0）
  const tx5 = await nft.sync(tokenId);
  await tx5.wait();
  p = await params();
  console.log('5️⃣ sync后:    stage=%d energy=%d', n(p.stage), n(p.energy));

  // 6. tokenURI：高阶段应含双光环 + XP 属性
  const uri = await nft.tokenURI(tokenId);
  const json = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString());
  const svg = Buffer.from(json.image.split(',')[1], 'base64').toString();
  const attrs = Object.fromEntries(json.attributes.map((a) => [a.trait_type, a.value]));
  console.log('\n6️⃣ tokenURI: name=%s stage=%s XP=%s', json.name, attrs.Stage, attrs.XP);
  console.log('   SVG 含外光环:', svg.includes('r="170"'), '| 双光环:', svg.includes('r="196"'), '| 卫星:', svg.includes('cx="360"'));
  if (attrs.Stage !== 'Radiant' || attrs.XP !== '100') throw new Error('tokenURI 属性错误');
  if (!svg.includes('r="170"') || !svg.includes('r="196"')) throw new Error('高阶段光环缺失');

  console.log('\n🎉 Living NFT 全流程测试通过');
}

main().catch((e) => {
  console.error('❌ 测试失败:', e.message || e);
  process.exit(1);
});
