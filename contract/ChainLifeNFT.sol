// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Chain Life NFT — 链上生命 (Living NFT)
/// @notice 每个钱包只能铸造一个属于自己的生命体。
///         它是"活"的：feed() 记录链上行为事件并积累 XP，sync() 从钱包实时链上状态
///         （余额 + 交易数 + XP）重算生命阶段与形态。SVG 全链上渲染，随阶段进化。
contract ChainLifeNFT is ERC721 {
    using Strings for uint256;

    struct LifeParams {
        uint16 txCount;    // 钱包交易数（sync 时从 nonce 更新）
        uint8 r;           // 基因组颜色 R（出生时固定）
        uint8 g;           // 基因组颜色 G
        uint8 b;           // 基因组颜色 B
        uint16 energy;     // 链上能量 = 余额×400(上限8000) + 交易数 + XP×20
        uint8 stage;       // 生命阶段 0-8，由能量推导
        uint8 vitality;    // 生命力 0-99
        uint256 xp;        // 链上行为积累的经验值（feed 事件）
        uint256 lastFeedAt;// 上次喂食时间戳（1 小时消化冷却）
        uint256 bornAt;    // 出生时间戳
        string lastEvent;  // 最近一次事件 ID
    }

    mapping(uint256 => LifeParams) public lifeParams;
    uint256 public totalMinted;

    event Fed(uint256 indexed tokenId, string source, string eventId, uint256 xp);
    event Evolved(uint256 indexed tokenId, uint256 energy, uint8 stage, uint256 txCount);

    constructor() ERC721("Chain Life", "CHAINLIFE") {}

    /// @dev tokenId = keccak256(msg.sender)，一钱包一生命
    function mint(
        uint16 txCount,
        uint8 r,
        uint8 g,
        uint8 b,
        uint16 energy,
        uint8 stage,
        uint8 vitality
    ) external returns (uint256 tokenId) {
        tokenId = uint256(keccak256(abi.encodePacked(msg.sender)));
        require(_ownerOf(tokenId) == address(0), "ChainLife: one per wallet");
        require(stage <= 8, "ChainLife: bad stage");

        _safeMint(msg.sender, tokenId);
        lifeParams[tokenId] =
            LifeParams(txCount, r, g, b, energy, stage, vitality, 0, 0, block.timestamp, "");
        totalMinted += 1;
        emit Evolved(tokenId, energy, stage, txCount);
    }

    /// @notice 链上行为事件喂食：交易即进食，事件驱动进化。
    /// @dev 任何人可为任何生命喂食（keeper/前端观测 GMX 等协议事件后调用），
    ///      1 小时消化冷却防刷，来源字符串决定 XP 增益。
    function feed(uint256 tokenId, string calldata source, string calldata eventId) external {
        require(_ownerOf(tokenId) != address(0), "ChainLife: not minted");
        LifeParams storage p = lifeParams[tokenId];
        require(block.timestamp >= p.lastFeedAt + 1 hours, "ChainLife: digesting");

        p.lastFeedAt = block.timestamp;
        p.xp += _xpGain(source);
        p.lastEvent = eventId;

        _sync(_ownerOf(tokenId), p);
        emit Fed(tokenId, source, eventId, p.xp);
    }

    /// @notice 从钱包实时链上状态（余额 + XP）重算能量/阶段/生命力。
    /// @dev 任何人可调用，结果完全由链上可验证数据决定，无主观输入。
    function sync(uint256 tokenId) external {
        require(_ownerOf(tokenId) != address(0), "ChainLife: not minted");
        LifeParams storage p = lifeParams[tokenId];
        _sync(_ownerOf(tokenId), p);
    }

    /// @notice 同步钱包当前交易数（nonce）。EVM 无法在合约内读取外部地址 nonce，
    ///         故由前端/keeper 从公开 RPC 读取后上链，任何人可为任何生命更新。
    function syncStats(uint256 tokenId, uint16 txCount) external {
        require(_ownerOf(tokenId) != address(0), "ChainLife: not minted");
        LifeParams storage p = lifeParams[tokenId];
        p.txCount = txCount;
        _sync(_ownerOf(tokenId), p);
    }

    // ---- 内部：能量与阶段推导（与前端 LIFECYCLE 阈值一致） ----

    function _balanceBoost(address owner) internal view returns (uint256) {
        // 财富即岁月：余额(ETH)×400，上限 8000（与前端一致）
        return _min(8000, owner.balance * 400 / 1 ether);
    }

    function _energy(address owner, LifeParams memory p) internal view returns (uint256) {
        // 余额实时链上读取；交易数由 syncStats 从公开 RPC nonce 同步上链
        return _balanceBoost(owner) + p.txCount + p.xp * 20;
    }

    function _stageFrom(uint256 energy) internal pure returns (uint8) {
        uint16[9] memory thresholds = [uint16(0), 10, 50, 150, 400, 1000, 2500, 5000, 8000];
        uint8 s = 0;
        for (uint8 i = 8; i >= 1; i--) {
            if (energy >= thresholds[i]) {
                s = i;
                break;
            }
        }
        return s;
    }

    function _vitalityFrom(uint8 stage, uint256 xp) internal pure returns (uint8) {
        uint256 v = 30 + uint256(stage) * 7 + xp / 100;
        return uint8(_min(99, v));
    }

    function _sync(address owner, LifeParams storage p) internal {
        uint256 energy = _energy(owner, p);
        p.energy = uint16(_min(65535, energy));
        p.stage = _stageFrom(energy);
        p.vitality = _vitalityFrom(p.stage, p.xp);
        emit Evolved(uint256(keccak256(abi.encodePacked(owner))), energy, p.stage, p.txCount);
    }

    function _xpGain(string memory source) internal pure returns (uint256) {
        bytes32 s = keccak256(bytes(source));
        if (s == keccak256("gmx-trade")) return 100; // 捕猎：GMX 合约交易
        if (s == keccak256("bridge")) return 30;     // 迁徙：跨链
        if (s == keccak256("swap")) return 15;       // 进食：DEX 交易
        if (s == keccak256("nft-mint")) return 10;   // 蜕皮：NFT 铸造
        return 5;                                    // 其他活动
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // ---- tokenURI：全链上动态 SVG，形态随阶段进化 ----

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);

        LifeParams memory p = lifeParams[tokenId];
        string memory svg = _renderSVG(p);

        string memory json = string(
            abi.encodePacked(
                '{"name":"Chain Life #',
                tokenId.toString(),
                '","description":"A living onchain organism grown from your Arbitrum wallet: it feeds on real onchain activity (GMX trades, swaps, bridges) and evolves stage by stage, rendered fully onchain.","attributes":[',
                '{"trait_type":"Stage","value":"',
                _stageName(p.stage),
                '"},{"trait_type":"Energy","value":"',
                uint256(p.energy).toString(),
                '"},{"trait_type":"Vitality","value":"',
                uint256(p.vitality).toString(),
                '"},{"trait_type":"Transactions","value":"',
                uint256(p.txCount).toString(),
                '"},{"trait_type":"XP","value":"',
                p.xp.toString(),
                '"},{"trait_type":"Born","display_type":"date","value":"',
                p.bornAt.toString(),
                '"}],"image":"data:image/svg+xml;base64,',
                Base64.encode(bytes(svg)),
                '"}'
            )
        );

        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }

    function _stageName(uint8 stage) internal pure returns (string memory) {
        if (stage == 0) return "Primordial";
        if (stage == 1) return "Emerged";
        if (stage == 2) return "Awakening";
        if (stage == 3) return "Growing";
        if (stage == 4) return "Thriving";
        if (stage == 5) return "Mature";
        if (stage == 6) return "Intense";
        if (stage == 7) return "Radiant";
        return "Ancient";
    }

    /// @dev 全链上 SVG：呼吸动画球体 + 星空背景 + 阶段形态（卫星/光环/三重环）
    function _renderSVG(LifeParams memory p) internal pure returns (string memory) {
        // 呼吸周期由生命力映射：活力越高呼吸越快
        uint256 dur = 4200 - (uint256(p.vitality) * 30); // 3.6s - 4.2s

        // 阶段形态：Growing(3) 起有卫星，Mature(5) 起有外光环，Radiant(7) 起双光环，Ancient(8) 三重环
        string memory satellites = p.stage >= 3
            ? string(
                abi.encodePacked(
                    '<circle cx="360" cy="150" r="4" fill="rgb(',
                    _rgb(p),
                    ')" opacity="0.85"/>',
                    '<circle cx="140" cy="360" r="3" fill="#ffffff" opacity="0.6"/>',
                    '<circle cx="400" cy="330" r="2.4" fill="rgb(',
                    _rgb(p),
                    ')" opacity="0.5"/>'
                )
            )
            : "";
        string memory halo1 = p.stage >= 5
            ? string(
                abi.encodePacked(
                    '<circle cx="250" cy="250" r="170" fill="none" stroke="rgb(',
                    _rgb(p),
                    ')" stroke-opacity="0.28" stroke-width="2">',
                    '<animate attributeName="r" values="170;182;170" dur="',
                    dur.toString(),
                    'ms" repeatCount="indefinite"/>',
                    '</circle>'
                )
            )
            : "";
        string memory halo2 = p.stage >= 7
            ? string(
                abi.encodePacked(
                    '<circle cx="250" cy="250" r="196" fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="1.2">',
                    '<animate attributeName="r" values="196;208;196" dur="',
                    dur.toString(),
                    'ms" repeatCount="indefinite"/>',
                    '</circle>'
                )
            )
            : "";
        string memory crown = p.stage == 8
            ? string(
                abi.encodePacked(
                    '<circle cx="250" cy="250" r="60" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1">',
                    '<animate attributeName="r" values="60;66;60" dur="',
                    dur.toString(),
                    'ms" repeatCount="indefinite"/>',
                    '</circle>'
                )
            )
            : "";

        return string(
            abi.encodePacked(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500">',
                '<rect width="500" height="500" fill="#05060b"/>',
                '<g fill="#ffffff">',
                '<circle cx="80" cy="90" r="1.2" opacity="0.6"/>',
                '<circle cx="150" cy="60" r="0.9" opacity="0.35"/>',
                '<circle cx="400" cy="110" r="1.1" opacity="0.5"/>',
                '<circle cx="450" cy="320" r="0.8" opacity="0.4"/>',
                '<circle cx="90" cy="380" r="1.0" opacity="0.45"/>',
                '<circle cx="320" cy="60" r="0.7" opacity="0.3"/>',
                '<circle cx="60" cy="230" r="0.9" opacity="0.35"/>',
                '<circle cx="430" cy="200" r="0.6" opacity="0.25"/>',
                '</g>',
                halo2,
                halo1,
                '<defs>',
                '<radialGradient id="glow" cx="50%" cy="50%" r="50%">',
                '<stop offset="0%" stop-color="rgb(',
                _rgb(p),
                ')" stop-opacity="0.55"/>',
                '<stop offset="45%" stop-color="rgb(',
                _rgb(p),
                ')" stop-opacity="0.22"/>',
                '<stop offset="100%" stop-color="rgb(',
                _rgb(p),
                ')" stop-opacity="0"/>',
                '</radialGradient>',
                '<radialGradient id="core" cx="50%" cy="50%" r="50%">',
                '<stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"/>',
                '<stop offset="18%" stop-color="rgb(',
                _rgb(p),
                ')" stop-opacity="0.85"/>',
                '<stop offset="70%" stop-color="rgb(',
                _rgb(p),
                ')" stop-opacity="0.35"/>',
                '<stop offset="100%" stop-color="rgb(',
                _rgb(p),
                ')" stop-opacity="0.05"/>',
                '</radialGradient>',
                '</defs>',
                '<circle cx="250" cy="250" r="150" fill="url(#glow)">',
                '<animate attributeName="r" values="150;164;150" dur="',
                dur.toString(),
                'ms" repeatCount="indefinite"/>',
                '<animate attributeName="opacity" values="0.75;1;0.75" dur="',
                dur.toString(),
                'ms" repeatCount="indefinite"/>',
                '</circle>',
                '<circle cx="250" cy="250" r="78" fill="url(#core)">',
                '<animate attributeName="r" values="78;86;78" dur="',
                dur.toString(),
                'ms" repeatCount="indefinite"/>',
                '</circle>',
                '<circle cx="250" cy="250" r="92" fill="none" stroke="rgb(',
                _rgb(p),
                ')" stroke-opacity="0.5" stroke-width="1.5">',
                '<animate attributeName="r" values="92;100;92" dur="',
                dur.toString(),
                'ms" repeatCount="indefinite"/>',
                '<animate attributeName="stroke-opacity" values="0.5;0.85;0.5" dur="',
                dur.toString(),
                'ms" repeatCount="indefinite"/>',
                '</circle>',
                crown,
                satellites,
                '<text x="250" y="452" text-anchor="middle" fill="#ffffff" fill-opacity="0.45" font-family="monospace" font-size="13">',
                _stageName(p.stage),
                unicode" · E",
                uint256(p.energy).toString(),
                unicode" · V",
                uint256(p.vitality).toString(),
                unicode" · XP",
                p.xp.toString(),
                '</text>',
                '</svg>'
            )
        );
    }

    function _rgb(LifeParams memory p) internal pure returns (string memory) {
        return string(
            abi.encodePacked(
                uint256(p.r).toString(), ",", uint256(p.g).toString(), ",", uint256(p.b).toString()
            )
        );
    }
}
