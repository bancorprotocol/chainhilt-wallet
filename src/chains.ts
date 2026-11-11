import "./env.js";
import { defineChain, type Address, type Chain } from "viem";
import {
  abstract,
  apeChain,
  arbitrum,
  arc,
  avalanche,
  base,
  baseSepolia,
  berachain,
  blast,
  bob,
  boba,
  bsc,
  celo,
  cronos,
  flowMainnet,
  gensyn,
  gnosis,
  hyperliquid,
  hyperliquidEvmTestnet,
  injective,
  ink,
  katana,
  linea,
  lisk,
  mainnet,
  manta,
  mantle,
  megaeth,
  metis,
  mode,
  monad,
  morph,
  optimism,
  plasma,
  plumeMainnet,
  polygon,
  rise,
  robinhood,
  ronin,
  scroll,
  sei,
  shape,
  somnia,
  soneium,
  sonic,
  stable,
  story,
  superseed,
  tempo,
  unichain,
  worldchain,
  xLayer,
  zircuit,
  zksync,
  zora,
} from "viem/chains";
import { ChainConfig } from "./types.js";

// viem has no RPC for Arc, a dead one for Metis, and no definition for the
// chains below; these RPCs are the chains' own or the ones the bridge
// providers publish.
const arcMainnet = defineChain({
  ...arc,
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
});
const metisAndromeda = defineChain({
  ...metis,
  rpcUrls: { default: { http: ["https://andromeda.metis.io/?owner=1088"] } },
});
const mythos = defineChain({
  id: 42018,
  name: "Mythos",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://mythos-mainnet.g.alchemy.com/public/"] },
  },
});
const doma = defineChain({
  id: 97477,
  name: "Doma",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://doma.drpc.org"] } },
});
const ethereal = defineChain({
  id: 5064014,
  name: "Ethereal",
  nativeCurrency: { name: "USDe", symbol: "USDe", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.ethereal.trade"] } },
});

function usdc(address: Address): ChainConfig["tokens"] {
  return [{ name: "USDC", decimals: 6, address }];
}

// Every EVM chain the API's bridge providers (Circle CCTP, Across, deBridge,
// Relay, Socket) can send from, so the wallet can start a bridge on any of them, plus
// the Base and HyperEVM testnets. RPC_URL_<chainId> overrides a chain's
// public RPC; the older per-chain variables still work.
const CHAIN_SOURCES: Array<{
  chain: Chain;
  rpcVariable?: string;
  tokens?: ChainConfig["tokens"];
}> = [
  {
    chain: mainnet,
    tokens: usdc("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
  },
  {
    chain: optimism,
    tokens: usdc("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"),
  },
  { chain: cronos },
  { chain: bsc },
  { chain: gnosis },
  {
    chain: unichain,
    tokens: usdc("0x078D782b760474a361dDA0AF3839290b0EF57AD6"),
  },
  {
    chain: polygon,
    rpcVariable: "POLYGON_RPC_URL",
    tokens: [
      // Native USDC: what prediction-market deposits are funded with.
      { name: "USDC", decimals: 6, address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
      // Bridged USDC.e, still the wider-liquidity variant on Polygon.
      { name: "USDC.e", decimals: 6, address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" },
      // Balance display only.
      { name: "pUSD", decimals: 6, address: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" },
    ],
  },
  { chain: monad },
  { chain: sonic, tokens: usdc("0x29219dd400f2Bf60E5a23d13Be72B486D4038894") },
  { chain: manta },
  { chain: xLayer },
  { chain: boba },
  { chain: zksync },
  { chain: shape },
  {
    chain: worldchain,
    tokens: usdc("0x79A02482A880bCE3F13e09Da970dC34db4CD24d1"),
  },
  { chain: flowMainnet },
  { chain: stable },
  {
    chain: hyperliquid,
    rpcVariable: "HYPERLIQUID_RPC_URL",
    tokens: usdc("0xb88339CB7199b77E23DB6E890353E22632Ba630f"),
  },
  { chain: metisAndromeda },
  { chain: lisk },
  { chain: story },
  { chain: injective },
  { chain: soneium },
  { chain: ronin },
  { chain: abstract },
  { chain: morph },
  { chain: tempo },
  { chain: megaeth },
  { chain: robinhood },
  { chain: mantle },
  { chain: somnia },
  { chain: arcMainnet },
  { chain: superseed },
  {
    chain: base,
    rpcVariable: "BASE_RPC_URL",
    tokens: usdc("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  },
  { chain: plasma },
  { chain: apeChain },
  { chain: mode },
  { chain: mythos },
  {
    chain: arbitrum,
    tokens: usdc("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
  },
  { chain: celo },
  {
    chain: avalanche,
    tokens: usdc("0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"),
  },
  { chain: zircuit },
  { chain: ink },
  { chain: linea },
  { chain: bob },
  { chain: berachain },
  { chain: blast },
  { chain: doma },
  { chain: plumeMainnet },
  { chain: scroll },
  { chain: gensyn },
  { chain: katana },
  { chain: ethereal },
  { chain: zora },
  { chain: sei },
  { chain: rise },
  {
    chain: baseSepolia,
    rpcVariable: "BASE_SEPOLIA_RPC_URL",
    tokens: usdc("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  },
  {
    chain: hyperliquidEvmTestnet,
    rpcVariable: "HYPERLIQUID_TESTNET_RPC_URL",
    tokens: usdc("0x2B3370eE501B4a559b57D449569354196457D8Ab"),
  },
];

const SUPPORTED_CHAINS: ChainConfig[] = CHAIN_SOURCES.map(
  ({ chain, rpcVariable, tokens = [] }) => ({
    chain,
    chainId: chain.id,
    // An empty variable, as copied from .env.example, means unset.
    rpcUrl: getRpcUrl(
      chain,
      process.env[`RPC_URL_${chain.id}`] ||
        (rpcVariable && process.env[rpcVariable]) ||
        undefined,
    ),
    tokens,
  }),
);

export const SUPPORTED_CHAIN_CONFIG_MAP = new Map<
  ChainConfig["chainId"],
  ChainConfig
>(SUPPORTED_CHAINS.map((source) => [source.chainId, source]));

export function getChainConfig(chainId: ChainConfig["chainId"]): ChainConfig {
  const source = SUPPORTED_CHAIN_CONFIG_MAP.get(chainId);
  if (!source) {
    throw new Error(`Unsupported chain ID ${chainId}`);
  }
  return source;
}

export function getRpcUrl(
  chain: Chain,
  rpcOverride: string | undefined,
): string {
  // A blank override (an empty `*_RPC_URL=` line in .env) means unset.
  const rpcUrl =
    rpcOverride?.trim() || chain.rpcUrls["default"].http.find((r) => !!r);

  if (!rpcUrl) {
    throw new Error(
      `RPC URL for chain id ${chain.id} is either empty or undefined`,
    );
  }

  return rpcUrl;
}
