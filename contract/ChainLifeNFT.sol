// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Chain Life NFT — 链上生命
/// @notice 每个钱包地址只能铸造一个属于自己的"呼吸球"NFT。
///         艺术与元数据全部存储在链上（SVG + 呼吸动画）。
contract ChainLifeNFT is ERC721 {
    using Strings for uint256;

    struct LifeParams {
        uint16 txCount; // 钱包交易数（nonce）
        uint8 r;        // 球体颜色 R
        uint8 g;        // 球体颜色 G
        uint8 b;        // 球体颜色 B
        uint16 energy;  // 链上能量 = 余额×400 + 交易数
        uint8 stage;    // 生命阶段 0-8
        uint8 vitality; // 生命力 0-99
    }

    mapping(uint256 => LifeParams) public lifeParams;
    uint256 public totalMinted;

    constructor() ERC721("Chain Life", "CHAINLIFE") {}

    /// @dev tokenId = keccak256(msg.sender)，一钱包一 NFT
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
        lifeParams[tokenId] = LifeParams(txCount, r, g, b, energy, stage, vitality);
        totalMinted += 1;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);

        LifeParams memory p = lifeParams[tokenId];
        string memory svg = _renderSVG(p);

        string memory json = string(
            abi.encodePacked(
                '{"name":"Chain Life #',
                tokenId.toString(),
                '","description":"A living breathing organism generated from your Arbitrum wallet: stage driven by real on-chain balance and activity.","attributes":[',
                '{"trait_type":"Stage","value":"',
                _stageName(p.stage),
                '"},{"trait_type":"Energy","value":"',
                uint256(p.energy).toString(),
                '"},{"trait_type":"Vitality","value":"',
                uint256(p.vitality).toString(),
                '"},{"trait_type":"Transactions","value":"',
                uint256(p.txCount).toString(),
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

    /// @dev 全链上 SVG：呼吸动画球体 + 星空背景
    function _renderSVG(LifeParams memory p) internal pure returns (string memory) {
        // 呼吸周期由生命力映射：活力越高呼吸越快
        uint256 dur = 4200 - (uint256(p.vitality) * 30); // 3.6s - 4.2s

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
                '<text x="250" y="452" text-anchor="middle" fill="#ffffff" fill-opacity="0.45" font-family="monospace" font-size="13">',
                _stageName(p.stage),
                unicode" · E",
                uint256(p.energy).toString(),
                unicode" · V",
                uint256(p.vitality).toString(),
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
