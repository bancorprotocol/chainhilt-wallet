import assert from "node:assert/strict";
import test from "node:test";

import { isAddress } from "viem";
import { base, baseSepolia, hyperliquid, polygon } from "viem/chains";
import {
  getChainConfig,
  getRpcUrl,
  SUPPORTED_CHAIN_CONFIG_MAP,
} from "../src/chains.js";

test("getChainConfig resolves Base Sepolia defaults", () => {
  const source = getChainConfig(baseSepolia.id);

  assert.equal(source.chain.id, 84532);
  assert.deepEqual(source.tokens, [
    {
      name: "USDC",
      decimals: 6,
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    },
  ]);
});

test("getChainConfig resolves Base mainnet defaults", () => {
  const source = getChainConfig(base.id);

  assert.equal(source.chain.id, 8453);
  assert.deepEqual(source.tokens, [
    {
      name: "USDC",
      decimals: 6,
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
  ]);
});

test("getChainConfig resolves Polygon, where prediction-market deposits are sent", () => {
  const source = getChainConfig(polygon.id);

  assert.equal(source.chain.id, 137);
  assert.deepEqual(
    source.tokens.map((token) => token.name),
    ["USDC", "USDC.e", "pUSD"],
  );
  // Native USDC, not the bridged USDC.e, is what the bridge credits from.
  assert.equal(
    source.tokens[0].address,
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  );
});

test("unsupported chains are rejected", () => {
  assert.throws(() => getChainConfig(0), /Unsupported/);
});

test("getRpcUrl prefers explicit RPC overrides", () => {
  const rpcUrl = "https://example.invalid/rpc";

  assert.equal(getRpcUrl(hyperliquid, rpcUrl), rpcUrl);
});

test("the wallet sends on every chain a bridge can start from", () => {
  // Spot checks across viem chains, chains defined here, and the testnets.
  for (const chainId of [
    1, 143, 999, 1329, 4153, 5042, 42018, 42161, 5064014, 84532, 998,
  ]) {
    assert.equal(getChainConfig(chainId).chain.id, chainId);
  }
  assert.equal(SUPPORTED_CHAIN_CONFIG_MAP.size, 58);
  for (const config of SUPPORTED_CHAIN_CONFIG_MAP.values()) {
    assert.match(config.rpcUrl ?? "", /^https:\/\//, String(config.chainId));
  }
});

test("every configured token address carries a valid EIP-55 checksum", () => {
  // A mis-cased address passes loose checks, but viem refuses to read it.
  for (const config of SUPPORTED_CHAIN_CONFIG_MAP.values()) {
    for (const token of config.tokens ?? []) {
      assert.ok(isAddress(token.address), `${config.chainId} ${token.address}`);
    }
  }
});

test("getRpcUrl treats a blank override as unset", () => {
  const fallback = hyperliquid.rpcUrls.default.http[0];
  assert.equal(getRpcUrl(hyperliquid, ""), fallback);
  assert.equal(getRpcUrl(hyperliquid, "  "), fallback);
});
