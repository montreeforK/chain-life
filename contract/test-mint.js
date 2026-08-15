// 冒烟测试：部署钱包自铸一枚 NFT 并验证 tokenURI
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const RPC_URL = 'https://sepolia-rollup.arbitrum.io/rpc';

async function main() {
  const keyData = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployer-key.json'), 'utf-8'));
  const deployed = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployed.json'), 'utf-8'));

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(keyData.privateKey, provider);
  const contract = new ethers.Contract(deployed.address, deployed.abi, signer);

  // Solidity: keccak256(abi.encodePacked(msg.sender)) = keccak256(20字节地址)
  const tokenId = ethers.keccak256(signer.address);

  try {
    await contract.ownerOf(tokenId);
    console.log('该钱包已铸造过，直接验证 tokenURI');
  } catch {
    console.log('铸造中...');
    const tx = await contract.mint(17, 91, 219, 140, 493, 4, 65);
    await tx.wait();
    console.log('铸造成功, tx:', tx.hash);
  }

  const uri = await contract.tokenURI(tokenId);
  const jsonB64 = uri.replace('data:application/json;base64,', '');
  const meta = JSON.parse(Buffer.from(jsonB64, 'base64').toString('utf-8'));
  console.log('name:', meta.name);
  console.log('attributes:', JSON.stringify(meta.attributes));
  const svgB64 = meta.image.replace('data:image/svg+xml;base64,', '');
  const svg = Buffer.from(svgB64, 'base64').toString('utf-8');
  console.log('SVG 长度:', svg.length, '含 animate:', svg.includes('<animate'));
  fs.writeFileSync(path.join(__dirname, 'test-nft.svg'), svg);
  console.log('SVG 已存为 test-nft.svg');
  console.log('NFT 查看: https://sepolia.arbiscan.io/nft/' + deployed.address + '/' + tokenId);
}

main().catch((e) => { console.error('失败:', e.message || e); process.exit(1); });
