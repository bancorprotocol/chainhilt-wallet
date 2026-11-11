import { privateKeyToAccount } from "viem/accounts";
import { isAddressEqual, type Address } from "viem";
import { getChainConfig, SUPPORTED_CHAIN_CONFIG_MAP } from "./chains.js";
import type { McpConfig, WalletConfig } from "./types.js";
import { readPrivateKey, readWallet } from "./wallet.js";
import { DEFAULT_ACTIVE_CHAIN_ID, DEFAULT_API_BASE_URL } from "./common.js";

export function loadConfig(): WalletConfig {
  const activeChainId = getActiveChainId();
  const activeChainConfig = getChainConfig(activeChainId);
  const value = process.env.API_BASE_URL || DEFAULT_API_BASE_URL;
  const apiBaseUrl = parseApiBaseUrl(value);
  // Fails fast on a malformed key or wallet file; a keychain key is read on first use.
  readWallet();
  return {
    apiBaseUrl,
    activeChainConfig,
    chainConfigs: SUPPORTED_CHAIN_CONFIG_MAP,
  };
}

function getActiveChainId() {
  const rawActiveChainId =
    process.env.ACTIVE_CHAIN_ID || DEFAULT_ACTIVE_CHAIN_ID;
  let activeChainId = Number(rawActiveChainId);
  if (Number.isNaN(activeChainId)) {
    activeChainId = DEFAULT_ACTIVE_CHAIN_ID;
  }
  return activeChainId;
}

const WALLET_NOT_CONFIGURED =
  "wallet_not_configured: use wallet_setup or chainhilt wallet setup to import or create a wallet privately.";

// A wallet replaced on disk after the key was loaded; operations are refused
// until restart, so status, balances and signatures never name different wallets.
export function getWalletChangeWarning(
  config: WalletConfig,
): string | undefined {
  if (!config.account) return undefined;
  const current = readWallet()?.address;
  if (current && isAddressEqual(current, config.account.address)) {
    return undefined;
  }
  return `wallet_changed: this server signs as ${config.account.address}, but the configured wallet is now ${current ?? "removed"}. Restart the MCP server to use it.`;
}

// Read on first use and kept, so a live server keeps its signing identity and
// reads the keychain once.
export async function requireWallet(config: WalletConfig): Promise<McpConfig> {
  if (!config.account) {
    const key = await readPrivateKey();
    if (!key) throw new Error(WALLET_NOT_CONFIGURED);
    // A concurrent first load may have finished while this read was pending; its identity stays.
    config.account ??= privateKeyToAccount(key);
  }
  // Checked after the read, since the wallet may have changed while it was pending.
  const change = getWalletChangeWarning(config);
  if (change) throw new Error(change);
  return { ...config, account: config.account };
}

// The address needs no key, so the keychain is neither read nor prompted for.
export function requireWalletAddress(config: WalletConfig): Address {
  const change = getWalletChangeWarning(config);
  if (change) throw new Error(change);
  const address = config.account?.address ?? readWallet()?.address;
  if (!address) throw new Error(WALLET_NOT_CONFIGURED);
  return address;
}

function parseApiBaseUrl(value: string): string {
  const { protocol, hostname } = new URL(value);
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  if (protocol !== "https:" && !(protocol === "http:" && isLocal)) {
    throw new Error(
      "API_BASE_URL must use https (plain http is allowed only for localhost)",
    );
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
