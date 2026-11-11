import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters } from "viem";
import { z } from "zod";
import { readBalance } from "../src/balance.js";
import { getChainConfig } from "../src/chains.js";

const address = "0x0000000000000000000000000000000000000001";
const token = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

test("balances use the selected network and preserve native/token units", async (t) => {
  const urls: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, options?: RequestInit) => {
      urls.push(String(input));
      const rpc = z
        .object({
          id: z.number(),
          method: z.string(),
          params: z.array(z.json()),
        })
        .parse(JSON.parse(String(options?.body)));
      let result: string;
      if (rpc.method === "eth_getBalance") result = "0xde0b6b3a7640000";
      else {
        const call = z.object({ data: z.string() }).parse(rpc.params[0]);
        result = call.data.startsWith("0x70a08231")
          ? encodeAbiParameters([{ type: "uint256" }], [1000000n])
          : call.data.startsWith("0x313ce567")
            ? encodeAbiParameters([{ type: "uint8" }], [6])
            : encodeAbiParameters([{ type: "string" }], ["USDC"]);
      }
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    },
  );
  const native = await readBalance(address, 84532);
  assert.equal(native.chainId, 84532);
  assert.equal(native.formatted, "1");
  assert.equal(urls[0], new URL(getChainConfig(84532).rpcUrl!).href);
  const balance = await readBalance(address, 8453, token);
  assert.equal(balance.chainId, 8453);
  assert.equal(balance.formatted, "1");
  assert.equal(balance.symbol, "USDC");
  assert.ok(
    urls
      .slice(1)
      .every((url) => url === new URL(getChainConfig(8453).rpcUrl!).href),
  );
});

test("RPC errors reject rather than pretending a wallet is empty", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "unavailable" }, { status: 503 }),
  );
  await assert.rejects(readBalance(address, 8453));
});

for (const failingCall of ["balanceOf", "decimals", "symbol"] as const) {
  test(`token balances handle a failing ${failingCall} call`, async (t) => {
    const selectors = {
      balanceOf: "0x70a08231",
      decimals: "0x313ce567",
      symbol: "0x95d89b41",
    };
    t.mock.method(
      globalThis,
      "fetch",
      async (_input: string | URL | Request, options?: RequestInit) => {
        const rpc = z
          .object({
            id: z.number(),
            params: z.tuple([z.object({ data: z.string() }), z.json()]),
          })
          .parse(JSON.parse(String(options?.body)));
        const data = rpc.params[0].data;
        if (data.startsWith(selectors[failingCall])) {
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32000, message: "execution reverted" },
          });
        }
        const result = data.startsWith(selectors.balanceOf)
          ? encodeAbiParameters([{ type: "uint256" }], [1000000n])
          : data.startsWith(selectors.decimals)
            ? encodeAbiParameters([{ type: "uint8" }], [6])
            : encodeAbiParameters([{ type: "string" }], ["USDC"]);
        return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
      },
    );
    if (failingCall === "symbol") {
      const balance = await readBalance(address, 8453, token);
      assert.equal(balance.formatted, "1");
      assert.equal(balance.decimals, 6);
      assert.equal("symbol" in balance, false);
    } else {
      await assert.rejects(readBalance(address, 8453, token), (error: Error) => {
        assert.equal(
          error.message,
          `Failed to fetch wallet balance for tokenAddress ${token}.`,
        );
        assert.ok(error.cause instanceof Error);
        return true;
      });
    }
  });
}

test("a failed native balance read does not quote the RPC URL, which may carry a key", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(readBalance(address, 8453), (error: Error) => {
    assert.equal(
      error.message,
      "Failed to fetch the native balance on chain 8453.",
    );
    assert.ok(error.cause instanceof Error);
    return true;
  });
});
