// 部署 ChainLifeNFT 到 Arbitrum Sepolia
// 用法: node deploy.js [deployer-key.json]
// 没有 key 文件时自动生成新钱包并保存，然后需先领水龙头测试币再部署
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { compile, CONTRACT_NAME } = require('./compile');

const RPC_URL = 'https://sepolia-rollup.arbitrum.io/rpc';
const KEY_FILE = path.join(__dirname, 'deployer-key.json');

async function main() {
  let wallet;
  if (fs.existsSync(KEY_FILE)) {
    const keyData = JSON.parse(fs.readFileSync(KEY_FILE, 'utf-8'));
    wallet = new ethers.Wallet(keyData.privateKey);
  } else {
    wallet = ethers.Wallet.createRandom();
    fs.writeFileSync(KEY_FILE, JSON.stringify({
      address: wallet.address,
      privateKey: wallet.privateKey,
      note: 'Arbitrum Sepolia 部署钱包（测试网专用，勿存放真实资产）'
    }, null, 2), { mode: 0o600 });
    console.log('已生成新部署钱包（仅测试网使用）:');
    console.log('  address:', wallet.address);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = wallet.connect(provider);

  const balance = await provider.getBalance(wallet.address);
  console.log('部署钱包余额:', ethers.formatEther(balance), 'ETH');
  if (balance === 0n) {
    console.log('余额为 0，请先通过水龙头领取测试币，然后重新运行本脚本。');
    process.exit(0);
  }

  console.log('编译合约...');
  const { abi, bytecode } = compile();

  console.log('部署中...');
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log('✅ 部署成功:', address);

  fs.writeFileSync(path.join(__dirname, 'deployed.json'), JSON.stringify({
    name: CONTRACT_NAME,
    address,
    network: 'Arbitrum Sepolia (421614)',
    abi
  }, null, 2));
  console.log('已写入 deployed.json');
  console.log('浏览器验证: https://sepolia.arbiscan.io/address/' + address);
}

main().catch((e) => {
  console.error('部署失败:', e.message || e);
  process.exit(1);
});
