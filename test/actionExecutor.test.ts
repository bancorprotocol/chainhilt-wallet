import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import test, { type Mock, type TestContext } from "node:test";
import {
  encodeFunctionData,
  erc20Abi,
  keccak256,
  numberToHex,
  parseEther,
  parseTransaction,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { executeApiActions, processAction } from "../src/actionExecutor.js";
import { createApiClient } from "../src/http.js";
import {
  ACTION_VERIFICATION_PATH,
  createRequestLedger,
  hashAction,
  WALLET_AUTHORIZATION_HEADER,
} from "../src/actionVerification.js";
import type {
  ApiClient,
  RequestLedger,
  ChainConfigMap,
  McpConfig,
  SignatureApiAction,
  TransactionApiAction,
} from "../src/types.js";

const privateKey = `0x${"0".repeat(63)}1` as const;
const walletAddress = privateKeyToAccount(privateKey).address;
const requestNonce = `0x${"12".repeat(32)}` as const;

function signatureAction(submitPath: string) {
  return stamp({
    type: "signature",
    protocol: "hyperliquid",
    chainId: base.id,
    submitPath,
    data: {
      typedData: {
        domain: { name: "Test", version: "1", chainId: base.id },
        types: { Message: [{ name: "value", type: "string" }] },
        primaryType: "Message",
        message: { value: submitPath },
      },
    },
  } satisfies Omit<SignatureApiAction, "verification">);
}

// A stamp for this wallet's request; the mocked API decides whether its tag
// is ours.
function stamp<
  T extends
    | Omit<SignatureApiAction, "verification">
    | Omit<TransactionApiAction, "verification">,
>(
  action: T,
  { subject = walletAddress.toLowerCase(), nonce = requestNonce } = {},
) {
  return {
    ...action,
    verification: {
      hash: hashAction(action),
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      subject,
      nonce,
      tag: `0x${"cd".repeat(32)}`,
    },
  };
}

function createLedger(): RequestLedger {
  const ledger = createRequestLedger();
  ledger.issue(requestNonce, Math.floor(Date.now() / 1000) + 300);
  return ledger;
}

function createApi(issued: (hash: string) => boolean = () => true): ApiClient {
  return {
    async get<T>(): Promise<T> {
      throw new Error("Unexpected GET");
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      if (path === ACTION_VERIFICATION_PATH) {
        const { hash } = body as { hash: string };
        return (
          issued(hash)
            ? { valid: true }
            : { valid: false, reason: "not_issued" }
        ) as T;
      }
      return JSON.parse('{"ok":true}') as T;
    },
  };
}

function submitPaths(post: Mock<ApiClient["post"]>) {
  return post.mock.calls
    .map(({ arguments: args }) => args[0])
    .filter((path) => path !== ACTION_VERIFICATION_PATH);
}

function drain(from: `0x${string}`) {
  return {
    type: "transaction",
    chainId: base.id,
    data: {
      from,
      to: `0x${"99".repeat(20)}`,
      data: "0x",
      value: "1000000000000000000",
    },
  } satisfies Omit<TransactionApiAction, "verification">;
}

test("all successful actions are returned in executed with failed undefined", async (t) => {
  const account = privateKeyToAccount(privateKey);
  const api = createApi();
  const post = t.mock.method(api, "post");
  const actions = [signatureAction("/submit"), signatureAction("/second")];

  const result = await executeApiActions(
    api,
    account,
    createLedger(),
    actions,
    new Map(),
  );

  assert.equal(result.failed, undefined);
  assert.equal(result.executed.length, 2);
  assert.deepEqual(submitPaths(post), ["/submit", "/second"]);
  for (const execution of result.executed) {
    assert.equal(execution.type, "signature");
    if (execution.type !== "signature")
      assert.fail("Expected signature execution");
    assert.deepEqual(execution.submitted, { ok: true });
    assert.match(execution.signedPayload.signature.r, /^0x[0-9a-f]{64}$/);
    assert.equal("verification" in execution.signedPayload, false);
  }
});

test("a batch with one action the API did not issue signs and sends nothing", async (t) => {
  const account = privateKeyToAccount(privateKey);
  const issuedAction = signatureAction("/submit");
  const api = createApi((hash) => hash === issuedAction.verification.hash);
  const post = t.mock.method(api, "post");
  const sign = t.mock.method(account, "signTypedData");
  const fetch = t.mock.method(globalThis, "fetch");
  // Shaped like ours, correctly hashed and for this wallet, but not stamped by the API.
  const forged = stamp(drain(account.address));

  const result = await executeApiActions(
    api,
    account,
    createLedger(),
    [issuedAction, forged],
    new Map(),
  );

  assert.equal(result.isError, true);
  assert.deepEqual(result.executed, []);
  assert.deepEqual(result.failed?.failedAtAction, forged);
  assert.match(result.failed?.error ?? "", /did not issue this action/);
  assert.deepEqual(submitPaths(post), []);
  assert.equal(sign.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
});

test("genuine stamps relayed from someone else's request are refused before asking the API", async (t) => {
  const account = privateKeyToAccount(privateKey);
  const api = createApi();
  const post = t.mock.method(api, "post");
  const ledger = createLedger();

  // An attacker requested these from the API itself: one for its own wallet,
  // one naming this wallet but under a nonce this wallet never signed.
  for (const relayed of [
    stamp(drain(account.address), { subject: `0x${"99".repeat(20)}` }),
    stamp(drain(account.address), { nonce: `0x${"34".repeat(32)}` }),
  ]) {
    const result = await executeApiActions(
      api,
      account,
      ledger,
      [relayed],
      new Map(),
    );
    assert.equal(result.isError, true);
    assert.deepEqual(result.executed, []);
    assert.match(
      result.failed?.error ?? "",
      /another wallet|does not come from a request this wallet authorized/,
    );
  }
  assert.equal(post.mock.callCount(), 0);
});

test("each stamped action runs at most once", async (t) => {
  const account = privateKeyToAccount(privateKey);
  const api = createApi();
  const post = t.mock.method(api, "post");
  const ledger = createLedger();
  const action = signatureAction("/submit");

  const duplicated = await executeApiActions(
    api,
    account,
    ledger,
    [action, action],
    new Map(),
  );
  assert.match(
    duplicated.failed?.error ?? "",
    /already executed or is being executed/,
  );
  assert.deepEqual(submitPaths(post), []);

  const first = await executeApiActions(
    api,
    account,
    ledger,
    [action],
    new Map(),
  );
  assert.equal(first.failed, undefined);
  const replay = await executeApiActions(
    api,
    account,
    ledger,
    [action],
    new Map(),
  );
  assert.match(replay.failed?.error ?? "", /already executed/);
  assert.deepEqual(submitPaths(post), ["/submit"]);
});

test("concurrent calls carrying the same action execute it once", async (t) => {
  const account = privateKeyToAccount(privateKey);
  const api = createApi();
  // Hold every verification until both calls are past their synchronous
  // checks, the window in which an unreserved action could pass twice.
  let releaseVerifications: () => void = () => {};
  const gate = new Promise<void>((resolve) => (releaseVerifications = resolve));
  const realPost = api.post;
  const post = t.mock.method(api, "post", (async (
    path: string,
    body: unknown,
  ) => {
    if (path === ACTION_VERIFICATION_PATH) await gate;
    return realPost(path, body);
  }) as ApiClient["post"]);
  const ledger = createLedger();
  const action = signatureAction("/submit");

  const calls = [
    executeApiActions(api, account, ledger, [action], new Map()),
    executeApiActions(api, account, ledger, [action], new Map()),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  releaseVerifications();
  const results = await Promise.all(calls);

  const outcomes = results.map((result) => result.executed.length);
  assert.deepEqual(outcomes.sort(), [0, 1]);
  const refused = results.find((result) => result.isError);
  assert.match(
    refused?.failed?.error ?? "",
    /already executed or is being executed/,
  );
  assert.deepEqual(submitPaths(post), ["/submit"]);
});

test("a refused batch releases its verified actions for a later call", async (t) => {
  const account = privateKeyToAccount(privateKey);
  const good = signatureAction("/submit");
  const foreign = stamp(drain(account.address));
  const api = createApi((hash) => hash === good.verification.hash);
  const post = t.mock.method(api, "post");
  const ledger = createLedger();

  const refused = await executeApiActions(
    api,
    account,
    ledger,
    [good, foreign],
    new Map(),
  );
  assert.deepEqual(refused.failed?.failedAtAction, foreign);
  assert.deepEqual(submitPaths(post), []);

  const retry = await executeApiActions(
    api,
    account,
    ledger,
    [good],
    new Map(),
  );
  assert.equal(retry.failed, undefined);
  assert.deepEqual(submitPaths(post), ["/submit"]);
});

test("an action changed after it was stamped is refused before asking the API", async (t) => {
  const account = privateKeyToAccount(privateKey);
  const api = createApi();
  const post = t.mock.method(api, "post");
  const tampered = {
    ...signatureAction("/submit"),
    submitPath: "/perp/hyperliquid/send-asset/execute",
  };

  const result = await executeApiActions(
    api,
    account,
    createLedger(),
    [tampered],
    new Map(),
  );

  assert.equal(result.isError, true);
  assert.deepEqual(result.failed?.failedAtAction, tampered);
  assert.match(result.failed?.error ?? "", /does not match/);
  assert.equal(post.mock.callCount(), 0);
});

for (const failure of ["signing", "submission", "transaction"] as const) {
  for (const successfulCount of [0, 1]) {
    test(`${failure} failure returns ${successfulCount} completed actions and stops execution`, async (t) => {
      const account = privateKeyToAccount(privateKey);
      const api = createApi();
      const post = t.mock.method(api, "post");
      const sign = t.mock.method(account, "signTypedData");
      const message = `${failure} failed`;
      const transaction = stamp({
        type: "transaction",
        chainId: base.id,
        data: {
          from: account.address,
          to: account.address,
          data: "0x",
          value: "0",
        },
      } satisfies Omit<TransactionApiAction, "verification">);
      const chains: ChainConfigMap = new Map([
        [
          base.id,
          {
            chain: base,
            chainId: base.id,
            tokens: [],
            rpcUrl: "https://rpc.invalid",
          },
        ],
      ]);

      if (failure === "signing") {
        sign.mock.mockImplementationOnce(async () => {
          throw new Error(message);
        }, successfulCount);
      } else if (failure === "submission") {
        // Verification precedes every submission; fail the next submission.
        post.mock.mockImplementation((async (path: string) => {
          if (path === ACTION_VERIFICATION_PATH) return { valid: true };
          if (submitPaths(post).length >= successfulCount)
            throw new Error(message);
          return { ok: true };
        }) as ApiClient["post"]);
      } else {
        t.mock.method(
          globalThis,
          "fetch",
          async () =>
            new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                error: { code: -32602, message },
              }),
              { headers: { "Content-Type": "application/json" } },
            ),
        );
      }

      const failedAction =
        failure === "transaction" ? transaction : signatureAction("/fails");
      const result = await executeApiActions(
        api,
        account,
        createLedger(),
        [
          ...Array.from({ length: successfulCount }, (_, index) =>
            signatureAction(`/succeeds-${index}`),
          ),
          failedAction,
          signatureAction("/must-not-run"),
        ],
        chains,
      );

      assert.equal(result.executed.length, successfulCount);
      assert.ok(result.failed);
      assert.deepEqual(result.failed.failedAtAction, failedAction);
      assert.equal(typeof result.failed.error, "string");
      if (failure === "transaction")
        assert.match(result.failed.error, /transaction failed/);
      else assert.equal(result.failed.error, message);
      assert.equal(
        submitPaths(post).length,
        successfulCount + (failure === "submission" ? 1 : 0),
      );
      assert.equal(
        sign.mock.callCount(),
        successfulCount + (failure === "transaction" ? 0 : 1),
      );
    });
  }
}

test("actions passed by hash are fetched with a signed lookup, then verified and run", async (t) => {
  const account = privateKeyToAccount(privateKey);
  const actions = [signatureAction("/submit"), signatureAction("/second")];
  const byHash = new Map<string, unknown>(
    actions.map((action) => [action.verification.hash, action]),
  );
  const lookups: Array<{ path: string; header?: string }> = [];
  const api = createApi();
  api.get = async <T>(path: string, headers?: Record<string, string>) => {
    lookups.push({ path, header: headers?.[WALLET_AUTHORIZATION_HEADER] });
    return { action: byHash.get(path.split("/").pop() ?? "") } as T;
  };
  const post = t.mock.method(api, "post");
  const config = {
    apiBaseUrl: "http://localhost:3000/api/v1",
    account,
    chainConfigs: new Map(),
  } as unknown as McpConfig;
  const hashes = actions.map((action) => action.verification.hash);

  const result = await processAction(api, config, createLedger(), {
    nonce: requestNonce,
    hashes,
  });

  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(submitPaths(post), ["/submit", "/second"]);
  // The agent passed 66 characters per action; the wallet fetched the rest.
  assert.deepEqual(
    lookups.map(({ path }) => path),
    hashes.map((hash) => `/actions/${requestNonce}/${hash}`),
  );
  for (const { header } of lookups) {
    assert.match(header ?? "", new RegExp(`^${account.address}\\.0x[0-9a-f]{64}\\.\\d+\\.0x`));
  }
});

test("an action fetched for a hash it does not match is refused", async () => {
  const account = privateKeyToAccount(privateKey);
  const [first, second] = [signatureAction("/submit"), signatureAction("/second")];
  const api = createApi();
  api.get = async <T>() => ({ action: second }) as T;
  const config = {
    apiBaseUrl: "http://localhost:3000/api/v1",
    account,
    chainConfigs: new Map(),
  } as unknown as McpConfig;

  await assert.rejects(
    processAction(api, config, createLedger(), {
      nonce: requestNonce,
      hashes: [first.verification.hash],
    }),
    /The API returned another action for 0x/,
  );

  // The same action stamped for another request is not this request's.
  api.get = async <T>() =>
    ({
      action: {
        ...first,
        verification: { ...first.verification, nonce: `0x${"34".repeat(32)}` },
      },
    }) as T;
  await assert.rejects(
    processAction(api, config, createLedger(), {
      nonce: requestNonce,
      hashes: [first.verification.hash],
    }),
    /The API returned another action for 0x/,
  );

  // A malformed reply names the hash it was fetched for, like the other errors.
  api.get = async <T>() => ({ action: { type: "signature" } }) as T;
  await assert.rejects(
    processAction(api, config, createLedger(), {
      nonce: requestNonce,
      hashes: [first.verification.hash],
    }),
    new RegExp(`malformed action for ${first.verification.hash}`),
  );
});

test("the API client sends a lookup's headers", async (t) => {
  const seen: Array<Headers> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    seen.push(new Headers(init.headers));
    return new Response(JSON.stringify({ action: null }), {
      headers: { "content-type": "application/json" },
    });
  });
  const api = createApiClient({
    apiBaseUrl: "http://localhost:3000/api/v1",
  } as unknown as McpConfig);

  await api.get("/actions/0xab", { [WALLET_AUTHORIZATION_HEADER]: "signed" });

  assert.equal(seen[0].get(WALLET_AUTHORIZATION_HEADER), "signed");
});

async function apiAt(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return createApiClient({
    apiBaseUrl: `http://127.0.0.1:${address.port}/api/v1`,
  } as unknown as McpConfig);
}

test("the API client does not follow a redirect with a signed payload", async (t) => {
  const requested: Array<string | undefined> = [];
  const api = await apiAt(t, (request, response) => {
    requested.push(request.url);
    response.writeHead(308, { location: "/elsewhere" }).end("Redirecting");
  });

  await assert.rejects(
    api.post("/submit", { signature: "0x" }),
    /API POST \/submit failed with 308/,
  );
  assert.deepEqual(requested, ["/api/v1/submit"]);
});

test("the API client gives up on an API that never answers", async (t) => {
  const api = await apiAt(t, () => {});
  // Stands in for the real timeout, which is too long for a test.
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", () => timeout(20));

  await assert.rejects(
    api.post("/submit", {}),
    /API POST \/submit did not answer within 60 s; it may still have processed the request/,
  );
});

// A Base JSON-RPC node: each method answers from `overrides` first, with its
// call count, then with a plausible default. `calls` lists methods in order.
type RpcAnswer =
  { result: unknown } | { error: { code: number; message: string } };

const blockHash = `0x${"aa".repeat(32)}`;
const sentHash = `0x${"bb".repeat(32)}`;

function fakeRpc(
  t: TestContext,
  overrides: Record<
    string,
    // undefined falls back to the default answer.
    (count: number, params: Record<string, string>[]) => RpcAnswer | undefined
  > = {},
) {
  const calls: string[] = [];
  // Receipts carry the hash of the transaction that was sent, as a node's do.
  let lastHash = sentHash;
  const receipt = () => ({
    transactionHash: lastHash,
    transactionIndex: "0x0",
    blockHash,
    blockNumber: "0x11",
    from: walletAddress,
    to: walletAddress,
    cumulativeGasUsed: "0x5208",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x2",
    contractAddress: null,
    logs: [],
    logsBloom: `0x${"00".repeat(256)}`,
    status: "0x1",
    type: "0x2",
  });
  const defaults: Record<string, unknown> = {
    eth_chainId: "0x2105",
    eth_getTransactionCount: "0x0",
    eth_getBlockByNumber: {
      number: "0x10",
      hash: blockHash,
      parentHash: blockHash,
      timestamp: "0x1",
      baseFeePerGas: "0x1",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      transactions: [],
    },
    eth_maxPriorityFeePerGas: "0x1",
    eth_estimateGas: "0x5208",
    eth_sendRawTransactionSync: undefined,
    eth_sendRawTransaction: undefined,
    eth_getTransactionReceipt: undefined,
    eth_blockNumber: "0x12",
  };
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      const { id, method, params } = JSON.parse(String(init.body)) as {
        id: number;
        method: string;
        params: Record<string, string>[];
      };
      calls.push(method);
      const count = calls.filter((called) => called === method).length;
      if (method.startsWith("eth_sendRawTransaction")) {
        lastHash = keccak256(params[0] as unknown as `0x${string}`);
      }
      const fallback =
        method === "eth_sendRawTransactionSync" ||
        method === "eth_getTransactionReceipt"
          ? receipt()
          : method === "eth_sendRawTransaction"
            ? lastHash
            : method === "eth_fillTransaction"
              ? undefined
              : defaults[method];
      const answer =
        overrides[method]?.(count, params) ??
        (method === "eth_fillTransaction" && fallback === undefined
          ? { error: { code: -32601, message: "method not found" } }
          : { result: fallback });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...answer }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  return calls;
}

const baseChains: ChainConfigMap = new Map([
  [
    base.id,
    {
      chain: base,
      chainId: base.id,
      tokens: [],
      rpcUrl: "https://rpc.invalid",
    },
  ],
]);

function transfer(to: `0x${string}`) {
  return stamp({
    type: "transaction",
    chainId: base.id,
    data: { from: walletAddress, to, data: "0x", value: "0" },
  } satisfies Omit<TransactionApiAction, "verification">);
}

for (const [code, answer] of [
  [-32601, "method not found"],
  [-32004, "method not supported"],
  [-32600, "Only core evm requests are allowed."],
] as const) {
  test(`a transaction falls back to a plain send when sync send answers ${code}`, async (t) => {
    const calls = fakeRpc(t, {
      eth_sendRawTransactionSync: () => ({ error: { code, message: answer } }),
    });

    const result = await executeApiActions(
      createApi(),
      privateKeyToAccount(privateKey),
      createLedger(),
      [transfer(`0x${"11".repeat(20)}`)],
      baseChains,
    );

    assert.equal(result.isError, false);
    assert.equal(result.executed.length, 1);
    const [executed] = result.executed;
    assert.match(
      ("receipt" in executed && executed.receipt.transactionHash) || "",
      /^0x[0-9a-f]{64}$/,
    );
    assert.equal(
      calls.filter((m) => m === "eth_sendRawTransactionSync").length,
      1,
    );
    assert.equal(calls.filter((m) => m === "eth_sendRawTransaction").length, 1);
  });
}

test("a sync send that fails for any other reason is followed, never sent again", async (t) => {
  const calls = fakeRpc(t, {
    eth_sendRawTransactionSync: () => ({
      error: { code: -32000, message: "request timed out" },
    }),
  });

  const result = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [transfer(`0x${"11".repeat(20)}`)],
    baseChains,
  );

  // The node mined it: the wallet reports the receipt.
  assert.equal(result.isError, false, result.failed?.error);
  assert.equal(calls.includes("eth_sendRawTransaction"), false);
  assert.equal(
    calls.filter((m) => m === "eth_sendRawTransactionSync").length,
    1,
  );
});

test("a transaction after a confirmed one waits for a lagging RPC to see it", async (t) => {
  // The node estimating the second transaction has not seen the first yet.
  const calls = fakeRpc(t, {
    eth_estimateGas: (count) =>
      count === 2
        ? {
            error: {
              code: 3,
              message:
                "execution reverted: ERC20: transfer amount exceeds allowance",
            },
          }
        : { result: "0x5208" },
  });

  const result = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [transfer(`0x${"11".repeat(20)}`), transfer(`0x${"22".repeat(20)}`)],
    baseChains,
  );

  assert.equal(result.isError, false, result.failed?.error);
  assert.equal(result.executed.length, 2);
  assert.equal(calls.filter((m) => m === "eth_estimateGas").length, 3);
  assert.equal(
    calls.filter((m) => m === "eth_sendRawTransactionSync").length,
    2,
  );
});

test("an action whose stamp expires while an earlier one confirms is not sent", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // The approval's receipt takes longer than the short quote has left.
  const calls = fakeRpc(t, {
    eth_sendRawTransactionSync: (count) => {
      if (count === 1) {
        t.mock.timers.tick(20_000);
      }
      return undefined;
    },
  });
  const bridge = transfer(`0x${"22".repeat(20)}`);
  bridge.verification.expiresAt = Math.floor(Date.now() / 1000) + 15;

  const result = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [transfer(`0x${"11".repeat(20)}`), bridge],
    baseChains,
  );

  assert.equal(result.isError, true);
  assert.equal(result.executed.length, 1);
  assert.equal(result.failed?.failedAtAction, bridge);
  assert.match(result.failed?.error ?? "", /expired at .* before it was sent/);
  assert.equal(
    calls.filter((m) => m === "eth_sendRawTransactionSync").length,
    1,
  );
});

test("a fallback send is not made once the stamp expired during the sync attempt", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // The RPC takes past the expiry to say it lacks sync send.
  const calls = fakeRpc(t, {
    eth_sendRawTransactionSync: () => {
      t.mock.timers.tick(20_000);
      return { error: { code: -32601, message: "method not found" } };
    },
  });
  const bridge = transfer(`0x${"22".repeat(20)}`);
  bridge.verification.expiresAt = Math.floor(Date.now() / 1000) + 15;

  const result = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [bridge],
    baseChains,
  );

  assert.equal(result.isError, true);
  assert.equal(result.executed.length, 0);
  assert.match(result.failed?.error ?? "", /expired at .* before it was sent/);
  assert.equal(calls.filter((m) => m === "eth_sendRawTransaction").length, 0);
});

test("a batch's first transaction is not retried when its estimate reverts", async (t) => {
  // Estimates with fee caps are send attempts; one without is the wallet
  // checking whether it could afford the gas.
  let attempts = 0;
  const calls = fakeRpc(t, {
    eth_estimateGas: (_count, [request]) => {
      attempts += request.maxFeePerGas ? 1 : 0;
      return { error: { code: 3, message: "execution reverted" } };
    },
  });

  const result = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [transfer(`0x${"11".repeat(20)}`)],
    baseChains,
  );

  assert.equal(result.isError, true);
  assert.equal(attempts, 1);
  assert.equal(calls.includes("eth_sendRawTransactionSync"), false);
});

const token = `0x${"33".repeat(20)}` as const;
const spender = `0x${"44".repeat(20)}` as const;

function approve(amount: bigint) {
  return stamp({
    type: "transaction",
    chainId: base.id,
    data: {
      from: walletAddress,
      to: token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, amount],
      }),
      value: "0",
    },
  } satisfies Omit<TransactionApiAction, "verification">);
}

for (const [name, amount, allowance, sent] of [
  ["is skipped when the allowance already covers it", 100n, 150n, false],
  ["is sent when the allowance falls short", 100n, 99n, true],
  ["to zero is always sent, to revoke the allowance", 0n, 150n, true],
] as const) {
  test(`an approve ${name}`, async (t) => {
    const calls = fakeRpc(t, {
      eth_call: () => ({ result: numberToHex(allowance, { size: 32 }) }),
    });

    const result = await executeApiActions(
      createApi(),
      privateKeyToAccount(privateKey),
      createLedger(),
      [approve(amount), transfer(spender)],
      baseChains,
    );

    assert.equal(result.isError, false, result.failed?.error);
    assert.equal("skipped" in result.executed[0], !sent);
    assert.equal(
      calls.filter((m) => m === "eth_sendRawTransactionSync").length,
      sent ? 2 : 1,
    );
  });
}

test("a transaction short of gas money fails with the shortfall, not a bare revert", async (t) => {
  const value = parseEther("1");
  fakeRpc(t, {
    // As a node does: with fee caps the gas is capped by what the balance
    // left after the value can pay, and the call runs out of it.
    eth_estimateGas: (_count, [request]) =>
      request.maxFeePerGas
        ? { error: { code: 3, message: "execution reverted" } }
        : { result: "0x7a120" },
    eth_getBalance: () => ({ result: numberToHex(value) }),
  });

  const result = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [
      stamp({
        type: "transaction",
        chainId: base.id,
        data: {
          from: walletAddress,
          to: spender,
          data: "0x",
          value: value.toString(),
        },
      } satisfies Omit<TransactionApiAction, "verification">),
    ],
    baseChains,
  );

  assert.equal(result.isError, true);
  assert.match(
    result.failed?.error ?? "",
    /^Not enough ETH for gas: the transaction sends 1 ETH and its gas can cost up to .* ETH at current fees, but the wallet holds 1 ETH\. Send less or add /,
  );
});

test("a reverting transaction the wallet can afford keeps its revert", async (t) => {
  fakeRpc(t, {
    eth_estimateGas: () => ({
      error: { code: 3, message: "execution reverted: InvalidQuoteTimestamp()" },
    }),
    eth_getBalance: () => ({ result: numberToHex(parseEther("1")) }),
  });

  const result = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [transfer(spender)],
    baseChains,
  );

  assert.equal(result.isError, true);
  assert.match(result.failed?.error ?? "", /InvalidQuoteTimestamp/);
});

// eth_fillTransaction as Ethereum and other nodes answer it; viem then signs
// what it returns.
function filled(chainId: number, to: `0x${string}`) {
  return {
    result: {
      raw: "0x",
      tx: {
        type: "0x2",
        chainId: numberToHex(chainId),
        nonce: "0x0",
        gas: "0x5208",
        maxFeePerGas: "0x2",
        maxPriorityFeePerGas: "0x1",
        from: walletAddress,
        to,
        value: "0x0",
        input: "0x",
      },
    },
  };
}

test("a send that times out after the broadcast is followed to its receipt, not sent again", async (t) => {
  const calls = fakeRpc(t, {
    eth_sendRawTransactionSync: () => ({
      error: { code: 4, message: "timeout waiting for receipt" },
    }),
    // The node has the transaction: it was broadcast.
    eth_getTransactionByHash: () => ({
      result: {
        hash: sentHash,
        nonce: "0x0",
        blockHash: null,
        blockNumber: null,
        transactionIndex: null,
        from: walletAddress,
        to: spender,
        value: "0x0",
        gas: "0x5208",
        input: "0x",
        type: "0x2",
        chainId: "0x2105",
        maxFeePerGas: "0x2",
        maxPriorityFeePerGas: "0x1",
        v: "0x0",
        r: "0x1",
        s: "0x1",
      },
    }),
  });

  const result = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [transfer(spender)],
    baseChains,
  );

  assert.equal(result.isError, false, result.failed?.error);
  assert.equal(calls.includes("eth_sendRawTransaction"), false);
  assert.ok(calls.includes("eth_getTransactionReceipt"));
});

test("a send the node already knows is treated as sent", async (t) => {
  const calls = fakeRpc(t, {
    eth_sendRawTransactionSync: () => ({
      error: { code: -32000, message: "already known" },
    }),
    eth_getTransactionByHash: () => ({
      result: {
        hash: sentHash,
        nonce: "0x0",
        blockHash: null,
        blockNumber: null,
        transactionIndex: null,
        from: walletAddress,
        to: spender,
        value: "0x0",
        gas: "0x5208",
        input: "0x",
        type: "0x2",
        chainId: "0x2105",
        maxFeePerGas: "0x2",
        maxPriorityFeePerGas: "0x1",
        v: "0x0",
        r: "0x1",
        s: "0x1",
      },
    }),
  });

  // After a confirmed transaction, so a stale-nonce retry would be allowed.
  const result = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [transfer(`0x${"11".repeat(20)}`), transfer(spender)],
    baseChains,
  );

  assert.equal(result.isError, false, result.failed?.error);
  // One sync send per transaction: "already known" is never re-signed.
  assert.equal(
    calls.filter((m) => m === "eth_sendRawTransactionSync").length,
    2,
  );
});

test("a stale nonce refused before broadcast is prepared and sent again", async (t) => {
  const calls = fakeRpc(t, {
    eth_sendRawTransactionSync: (count) =>
      count === 2
        ? { error: { code: -32000, message: "nonce too low" } }
        : undefined,
    // The refused transaction was not mined.
    eth_getTransactionReceipt: (count) =>
      count === 1 ? { result: null } : undefined,
  });

  const result = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [transfer(`0x${"11".repeat(20)}`), transfer(spender)],
    baseChains,
  );

  assert.equal(result.isError, false, result.failed?.error);
  assert.equal(
    calls.filter((m) => m === "eth_sendRawTransactionSync").length,
    3,
  );
});

test("an RPC that fills the transaction for another chain gets nothing signed", async (t) => {
  const calls = fakeRpc(t, {
    eth_fillTransaction: () => filled(1, spender),
  });

  const result = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [transfer(spender)],
    baseChains,
  );

  assert.equal(result.isError, true);
  assert.match(
    result.failed?.error ?? "",
    /The RPC prepared the transaction for chain 1, not 8453/,
  );
  assert.equal(calls.includes("eth_sendRawTransactionSync"), false);
});

test("the gas limit sent leaves 30% over the RPC's estimate", async (t) => {
  // OKX's swap on Base ran out of gas at 98.5% of a bare estimate.
  let sent: `0x${string}` | undefined;
  fakeRpc(t, {
    eth_sendRawTransactionSync: (_count, [raw]) => {
      sent = raw as unknown as `0x${string}`;
      return undefined;
    },
  });

  const result = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [transfer(`0x${"11".repeat(20)}`)],
    baseChains,
  );

  assert.equal(result.isError, false, result.failed?.error);
  assert.ok(sent);
  assert.equal(parseTransaction(sent).gas, (0x5208n * 130n) / 100n);
});

test("a fill that reverts behind a lagging RPC is retried after a confirmed transaction", async (t) => {
  const calls = fakeRpc(t, {
    eth_fillTransaction: (count) =>
      count === 2
        ? {
            error: {
              code: 3,
              message:
                "execution reverted: ERC20: transfer amount exceeds allowance",
            },
          }
        : filled(base.id, spender),
  });

  const result = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [transfer(`0x${"11".repeat(20)}`), transfer(spender)],
    baseChains,
  );

  assert.equal(result.isError, false, result.failed?.error);
  assert.equal(calls.filter((m) => m === "eth_fillTransaction").length, 3);
});

for (const [name, allowance, sent] of [
  // [approve(0), approve(100)] as Ethereum USDT needs.
  ["skips both approves when the allowance covers the amount", 150n, 0],
  ["skips the reset when there is nothing to clear", 0n, 1],
  ["clears a partial allowance before approving", 50n, 2],
] as const) {
  test(`a reset-then-approve pair ${name}`, async (t) => {
    fakeRpc(t, {
      eth_call: () => ({ result: numberToHex(allowance, { size: 32 }) }),
    });

    const result = await executeApiActions(
      createApi(),
      privateKeyToAccount(privateKey),
      createLedger(),
      [approve(0n), approve(100n), transfer(spender)],
      baseChains,
    );

    assert.equal(result.isError, false, result.failed?.error);
    assert.equal(
      result.executed.slice(0, 2).filter((action) => !("skipped" in action))
        .length,
      sent,
    );
  });
}

test("a batch for a chain the wallet does not support keeps its stamps", async (t) => {
  fakeRpc(t);
  const ledger = createLedger();
  const action = transfer(spender);

  const refused = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    ledger,
    [action],
    new Map(),
  );
  assert.equal(refused.isError, true);
  assert.match(refused.failed?.error ?? "", /Chain id 8453 not supported/);

  // Not used up: the same stamped action still runs once the chain is there.
  const sent = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    ledger,
    [action],
    baseChains,
  );
  assert.equal(sent.isError, false, sent.failed?.error);
});

function minedReceipt(hash: string, status = "0x1") {
  return {
    transactionHash: hash,
    transactionIndex: "0x0",
    blockHash,
    blockNumber: "0x11",
    from: walletAddress,
    to: spender,
    cumulativeGasUsed: "0x5208",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x2",
    contractAddress: null,
    logs: [],
    logsBloom: `0x${"00".repeat(256)}`,
    status,
    type: "0x2",
  };
}

test("a send whose fate is unknown is reported with its hash, never sent again", async (t) => {
  const calls = fakeRpc(t, {
    eth_sendRawTransactionSync: (count) =>
      count === 2
        ? { error: { code: -32000, message: "request timed out" } }
        : undefined,
    eth_getTransactionReceipt: () => ({
      error: { code: -32005, message: "rate limited" },
    }),
  });

  // The wallet waits up to 3 minutes for the receipt; mocked timers skip it.
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let settled = false;
  // After a confirmed transaction, where a pre-broadcast retry is allowed.
  const pending = executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [transfer(`0x${"11".repeat(20)}`), transfer(spender)],
    baseChains,
  ).finally(() => {
    settled = true;
  });
  for (let second = 0; second < 400 && !settled; second += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1_000);
  }
  const result = await pending;

  assert.equal(result.isError, true);
  assert.match(
    result.failed?.error ?? "",
    /^Transaction 0x[0-9a-f]{64} may have been sent \(.*\); check it before sending again$/,
  );
  assert.equal(
    calls.filter((m) => m === "eth_sendRawTransactionSync").length,
    2,
  );
});

test("a send the node refuses fails at once, without waiting for a receipt", async (t) => {
  const calls = fakeRpc(t, {
    eth_sendRawTransactionSync: () => ({
      error: {
        code: -32000,
        message: "insufficient funds for gas * price + value",
      },
    }),
    eth_getBalance: () => ({ result: numberToHex(parseEther("1")) }),
  });

  const result = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [transfer(spender)],
    baseChains,
  );

  assert.equal(result.isError, true);
  assert.equal(calls.includes("eth_getTransactionReceipt"), false);
});

test("a reverted or replaced transaction is not reported as executed", async (t) => {
  for (const [answer, message] of [
    [
      (hash: string) => minedReceipt(hash, "0x0"),
      /^Transaction 0x[0-9a-f]{64} reverted$/,
    ],
    [
      () => minedReceipt(`0x${"cc".repeat(32)}`),
      /was replaced by 0xcccc/,
    ],
  ] as const) {
    // The node gives the same receipt however it is asked.
    fakeRpc(t, {
      eth_sendRawTransactionSync: (_count, params) => ({
        result: answer(keccak256(params[0] as unknown as `0x${string}`)),
      }),
      eth_getTransactionReceipt: (_count, params) => ({
        result: answer(params[0] as unknown as string),
      }),
    });

    const result = await executeApiActions(
      createApi(),
      privateKeyToAccount(privateKey),
      createLedger(),
      [transfer(spender)],
      baseChains,
    );

    assert.equal(result.isError, true);
    assert.match(result.failed?.error ?? "", message);
    t.mock.restoreAll();
  }
});

test("an allowance that cannot be read never skips the reset", async (t) => {
  fakeRpc(t, {
    eth_call: () => ({ error: { code: -32000, message: "header not found" } }),
  });

  const result = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [approve(0n), approve(100n), transfer(spender)],
    baseChains,
  );

  assert.equal(result.isError, false, result.failed?.error);
  assert.equal(
    result.executed.slice(0, 2).filter((action) => "skipped" in action).length,
    0,
  );
});

test("a reset for another spender is not skipped by the approve after it", async (t) => {
  fakeRpc(t, {
    eth_call: () => ({ result: numberToHex(150n, { size: 32 }) }),
  });
  const otherSpender = `0x${"55".repeat(20)}` as const;
  const approveOther = stamp({
    type: "transaction",
    chainId: base.id,
    data: {
      from: walletAddress,
      to: token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [otherSpender, 100n],
      }),
      value: "0",
    },
  } satisfies Omit<TransactionApiAction, "verification">);

  const result = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [approve(0n), approveOther],
    baseChains,
  );

  assert.equal(result.isError, false, result.failed?.error);
  assert.equal("skipped" in result.executed[0], false);
});

test("an RPC on another chain gets nothing signed, also when it cannot fill", async (t) => {
  const calls = fakeRpc(t, { eth_chainId: () => ({ result: "0x1" }) });

  const result = await executeApiActions(
    createApi(),
    privateKeyToAccount(privateKey),
    createLedger(),
    [transfer(spender)],
    baseChains,
  );

  assert.equal(result.isError, true);
  assert.equal(calls.some((m) => m.startsWith("eth_sendRawTransaction")), false);
});
