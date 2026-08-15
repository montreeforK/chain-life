// 编译 ChainLifeNFT.sol（solc-js，import 从 node_modules 解析）
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const CONTRACT_NAME = 'ChainLifeNFT';

function findImports(importPath) {
  const full = path.join(__dirname, 'node_modules', importPath);
  if (fs.existsSync(full)) {
    return { contents: fs.readFileSync(full, 'utf-8') };
  }
  return { error: 'File not found: ' + importPath };
}

function compile() {
  const source = fs.readFileSync(path.join(__dirname, CONTRACT_NAME + '.sol'), 'utf-8');

  const input = {
    language: 'Solidity',
    sources: { [CONTRACT_NAME + '.sol']: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) {
    console.error('编译错误:');
    errors.forEach((e) => console.error(e.formattedMessage));
    process.exit(1);
  }

  const artifact = output.contracts[CONTRACT_NAME + '.sol'][CONTRACT_NAME];
  return { abi: artifact.abi, bytecode: '0x' + artifact.evm.bytecode.object };
}

module.exports = { compile, CONTRACT_NAME };
