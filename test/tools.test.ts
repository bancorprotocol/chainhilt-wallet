import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

// The OpenAI directory rejects a tool missing any of the four hints, so a new
// tool fails here until its hints are added.
const expectedAnnotations = {
  wallet_setup: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  mcp_status: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  get_chain_info: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  wallet_balance: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  authorize_request: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  process_action: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

// Not the default chain, so a default that ignores ACTIVE_CHAIN_ID fails.
const activeChainId = 84532;
const privateKey = `0x${"0".repeat(63)}2` as const;
const home = mkdtempSync(join(tmpdir(), "chainhilt tools "));
const rpcCalls: { method: string; params: unknown[] }[] = [];
// Stands in for the active chain's RPC through its RPC_URL_<chainId> override.
const rpc = createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  const { id, method, params } = z
    .object({ id: z.number(), method: z.string(), params: z.array(z.json()) })
    .parse(JSON.parse(text));
  rpcCalls.push({ method, params });
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify(
      method === "eth_getBalance"
        ? { jsonrpc: "2.0", id, result: "0xde0b6b3a7640000" }
        : { jsonrpc: "2.0", id, error: { code: -32601, message: method } },
    ),
  );
});
const client = new Client({ name: "tools-test", version: "1" });

before(async () => {
  await new Promise<void>((resolve) => rpc.listen(0, "127.0.0.1", resolve));
  const address = rpc.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
        "mcp",
      ],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        CHAINHILT_HOME: home,
        CHAINHILT_KEY_STORAGE: "file",
        WALLET_PRIVATE_KEY: "",
        API_BASE_URL: `${origin}/api/v1`,
        ACTIVE_CHAIN_ID: String(activeChainId),
        [`RPC_URL_${activeChainId}`]: `${origin}/rpc`,
      },
      stderr: "ignore",
    }),
  );
});

after(async () => {
  await client.close();
  rpc.closeAllConnections();
  rpc.close();
  rmSync(home, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .parse(result.content);
  return {
    isError: result.isError === true,
    text: content.find((entry) => entry.type === "text")?.text ?? "",
  };
}

async function callJson(name: string, args: Record<string, unknown> = {}) {
  const { isError, text } = await call(name, args);
  assert.ok(!isError, text);
  return z.record(z.string(), z.json()).parse(JSON.parse(text));
}

test("every tool declares all four annotation hints", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations])),
    expectedAnnotations,
  );
});

test("get_chain_info looks a chain up by id, then by name in any case", async () => {
  const byId = await callJson("get_chain_info", { chainId: 8453 });
  assert.equal(byId.chainId, 8453);
  assert.equal(byId.chainName, "Base");
  assert.deepEqual(
    await callJson("get_chain_info", { chainName: "bASE" }),
    byId,
  );
  // An id wins over another chain's name; an unknown id falls back to the name.
  assert.deepEqual(
    await callJson("get_chain_info", { chainId: 8453, chainName: "Ethereum" }),
    byId,
  );
  assert.deepEqual(
    await callJson("get_chain_info", { chainId: 999999999, chainName: "BASE" }),
    byId,
  );
  const unknown = await call("get_chain_info", {
    chainId: 999999999,
    chainName: "nowhere",
  });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Could not find chainConfig/);
});

test("wallet_balance defaults to the wallet's address on the active chain", async () => {
  const missing = await call("wallet_balance");
  assert.equal(missing.isError, true);
  assert.match(missing.text, /wallet_not_configured/);
  assert.equal(rpcCalls.length, 0);

  writeFileSync(join(home, "wallet.key"), `${privateKey}\n`, { mode: 0o600 });
  const wallet = privateKeyToAccount(privateKey).address;
  const balance = await callJson("wallet_balance");
  assert.equal(balance.address, wallet);
  assert.equal(balance.chainId, activeChainId);
  assert.equal(balance.asset, "native");
  assert.equal(balance.formatted, "1");
  // The read reached the active chain's RPC, for the wallet's address.
  assert.deepEqual(
    rpcCalls.map(({ method }) => method),
    ["eth_getBalance"],
  );
  assert.equal(String(rpcCalls[0].params[0]).toLowerCase(), wallet.toLowerCase());
});
