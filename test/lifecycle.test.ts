import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { hashAction } from "../src/actionVerification.js";
import type { SignatureApiAction } from "../src/types.js";

test("a running MCP configures a wallet and retains authorization across status and receive-page calls", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "chainhilt lifecycle "));
  const submitted: object[] = [];
  const api = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/actions/verify")
      response.end('{"valid":true}');
    else {
      submitted.push(JSON.parse(text));
      response.end('{"ok":true}');
    }
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    api.closeAllConnections();
    api.close();
    rmSync(home, { recursive: true, force: true });
  });
  async function connect() {
    const client = new Client({ name: "lifecycle-test", version: "1" });
    clients.push(client);
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
          API_BASE_URL: baseUrl,
        },
        stderr: "ignore",
      }),
    );
    return client;
  }
  const client = await connect();
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "wallet_setup"));
  assert.ok(!tools.some((tool) => tool.name === "wallet_fund"));
  async function call(
    name: string,
    args: Record<string, z.infer<ReturnType<typeof z.json>>> = {},
  ) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result.content));
    const content = z
      .array(z.object({ type: z.string(), text: z.string().optional() }))
      .parse(result.content);
    return z
      .record(z.string(), z.json())
      .parse(
        JSON.parse(
          content.find((entry) => entry.type === "text")?.text || "{}",
        ),
      );
  }
  assert.equal((await call("mcp_status")).configured, false);
  assert.equal(existsSync(join(home, "wallet.key")), false);
  const missing = await client.callTool({
    name: "authorize_request",
    arguments: { method: "POST", url: `${baseUrl}/preview`, body: {} },
  });
  assert.equal(missing.isError, true);
  const setup = z.object({ url: z.string() }).parse(await call("wallet_setup"));
  const url = new URL(setup.url);
  const saved = await fetch(`${url.origin}/wallet`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${url.hash.slice(1)}`,
      origin: url.origin,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      mode: "import",
      privateKey: `0x${"0".repeat(63)}1`,
    }),
  });
  assert.equal(saved.status, 201);
  const status = z
    .object({
      configured: z.boolean(),
      walletAddress: z.string(),
      keyStorage: z.string(),
      warning: z.string(),
    })
    .parse(await call("mcp_status"));
  assert.equal(status.configured, true);
  assert.equal(status.keyStorage, "file");
  assert.match(status.warning, /CHAINHILT_KEY_STORAGE=file/);
  const authorization = z
    .object({ headers: z.record(z.string(), z.string()) })
    .parse(
      await call("authorize_request", {
        method: "POST",
        url: `${baseUrl}/preview`,
        body: { amount: "1" },
      }),
    );
  const nonce =
    authorization.headers["X-ChainHilt-Authorization"].split(".")[1];
  await call("mcp_status");
  await call("wallet_setup", { chainId: 8453 });
  const action: Omit<SignatureApiAction, "verification"> = {
    type: "signature",
    protocol: "hyperliquid",
    chainId: 8453,
    submitPath: "/submit",
    data: {
      typedData: {
        domain: { name: "Test", version: "1", chainId: 8453 },
        types: { Message: [{ name: "value", type: "string" }] },
        primaryType: "Message",
        message: { value: "1" },
      },
    },
  };
  const stamp = {
    ...action,
    verification: {
      hash: hashAction(action),
      nonce,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      subject: status.walletAddress.toLowerCase(),
      tag: `0x${"cd".repeat(32)}`,
    },
  };
  const execution = await call("process_action", { actions: [stamp] });
  assert.equal(execution.isError, false);
  assert.ok(Array.isArray(execution.executed));
  assert.equal(execution.executed.length, 1);
  assert.equal(submitted.length, 1);
  // A refusal sets the MCP error flag, for clients that read only that.
  const duplicate = await client.callTool({
    name: "process_action",
    arguments: { actions: [stamp] },
  });
  assert.equal(duplicate.isError, true);
  assert.match(JSON.stringify(duplicate.content), /already executed/);
  assert.equal(submitted.length, 1);
  await client.close();
  const restarted = await connect();
  const refused = await restarted.callTool({
    name: "process_action",
    arguments: { actions: [stamp] },
  });
  assert.match(JSON.stringify(refused.content), /wallet authorized/);
  assert.equal(submitted.length, 1);

  // The server has loaded wallet A's key; another wallet replacing it on disk is
  // reported and refused until restart, never signed for as A.
  const authorize = {
    name: "authorize_request",
    arguments: { method: "POST", url: `${baseUrl}/preview`, body: {} },
  };
  assert.ok(!(await restarted.callTool(authorize)).isError);
  writeFileSync(join(home, "wallet.key"), `0x${"0".repeat(63)}2\n`);
  const changed = await restarted.callTool({
    name: "mcp_status",
    arguments: {},
  });
  assert.match(JSON.stringify(changed.content), /wallet_changed/);
  const stale = await restarted.callTool(authorize);
  assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale.content), /Restart the MCP server/);
});
