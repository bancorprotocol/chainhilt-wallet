import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  type Address,
} from "viem";
import { getChainConfig } from "./chains.js";

export async function readBalance(
  address: Address,
  chainId: number,
  tokenAddress?: Address,
) {
  const { chain, rpcUrl } = getChainConfig(chainId);
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 10_000, retryCount: 0 }),
  });
  if (!tokenAddress) {
    let balance: bigint;
    try {
      balance = await client.getBalance({ address });
    } catch (cause) {
      // viem's message lists the RPC URL, which may carry a key.
      throw new Error(
        `Failed to fetch the native balance on chain ${chainId}.`,
        { cause },
      );
    }
    return {
      address,
      chainId,
      asset: "native",
      balance: balance.toString(),
      formatted: formatUnits(balance, chain.nativeCurrency.decimals),
      ...chain.nativeCurrency,
    };
  }
  let balance: bigint;
  let decimals: number;
  let symbol: string | undefined;
  try {
    [balance, decimals, symbol] = await Promise.all([
      client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      }),
      client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "decimals",
      }),
      client
        .readContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "symbol",
        })
        .catch(() => undefined),
    ]);
  } catch (cause) {
    throw new Error(
      `Failed to fetch wallet balance for tokenAddress ${tokenAddress}.`,
      { cause },
    );
  }

  return {
    address,
    chainId,
    asset: "erc20",
    tokenAddress,
    balance: balance.toString(),
    formatted: formatUnits(balance, decimals),
    ...(symbol === undefined ? {} : { symbol }),
    decimals,
  };
}
