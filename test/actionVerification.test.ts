import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { privateKeyToAccount } from "viem/accounts";

import {
  ACTION_VERIFICATION_PATH,
  WALLET_AUTHORIZATION_HEADER,
  authorizeRequest,
  createRequestLedger,
  hashAction,
  verifyAction,
} from "../src/actionVerification.js";
import type { ApiClient, SignatureApiAction } from "../src/types.js";

const account = privateKeyToAccount(`0x${"0".repeat(63)}1`);
const apiBaseUrl = "https://chainhilt.ai/api/v1";
const nonce = `0x${"11".repeat(32)}` as const;

// Shared with tests/action.verification.test.ts in the API: both packages must
// hash this action to the same value, or the wallet refuses every action.
const goldenAction: Omit<SignatureApiAction, "verification"> = {
  type: "signature",
  chainId: 1337,
  protocol: "hyperliquid",
  submitPath: "/perp/hyperliquid/order/place/execute",
  data: {
    nonce: 1788105951789,
    action: {
      type: "order",
      orders: [
        {
          a: 0,
          b: true,
          p: "60000",
          s: "0.0002",
          r: false,
          t: { limit: { tif: "Gtc" } },
        },
      ],
      grouping: "na",
    },
    typedData: {
      domain: {
        name: "Exchange",
        version: "1",
        chainId: 1337,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      types: {
        Agent: [
          { name: "source", type: "string" },
          { name: "connectionId", type: "bytes32" },
        ],
      },
      primaryType: "Agent",
      message: { source: "a", connectionId: `0x${"11".repeat(32)}` },
    },
  },
};
const goldenHash =
  "0x8e617c681508b415a18c8008032c04a816da45dc95911c575bd9eff718148aed";

// Also shared with the API's tests, which accept exactly this header for
// exactly this request.
const goldenRequest = {
  url: `${apiBaseUrl}/bridge/execute`,
  method: "post",
  body: {
    sourceAmount: "1000000",
    sourceChainId: 8453,
    targetChainId: 42161,
    sourceToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    targetToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    adapterId: "circleCctp",
    senderAddress: account.address,
    recipientAddress: account.address,
  },
};
const goldenAuthorization =
  "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf.0x1111111111111111111111111111111111111111111111111111111111111111.1790000300.0x409494446eaf78ee31f6e2b178dba90dc649c96c3f9e9f106f298b578a19c7b633e9ec643a9c519219728c0aacaee0cbf4a259e2f3e82c2e443d4f8d334cf17e1c";

const now = 1790000000_000;
const action: SignatureApiAction = {
  ...goldenAction,
  verification: {
    hash: goldenHash,
    expiresAt: now / 1000 + 60,
    subject: account.address.toLowerCase(),
    nonce,
    tag: `0x${"cd".repeat(32)}`,
  },
};

function createApi(reply: unknown): ApiClient {
  return {
    async get<T>(): Promise<T> {
      throw new Error("Unexpected GET");
    },
    async post<T>(): Promise<T> {
      return reply as T;
    },
  };
}

function freezeClock(t: TestContext, ms = now) {
  t.mock.timers.enable({ apis: ["Date"], now: ms });
}

function issuedLedger() {
  const ledger = createRequestLedger();
  ledger.issue(nonce, now / 1000 + 300);
  return ledger;
}

test("the wallet hashes the shared golden vector like the API", () => {
  assert.equal(hashAction(goldenAction), goldenHash);
  assert.equal(hashAction(action), goldenHash);
  const reversed = Object.fromEntries(Object.entries(action).reverse());
  assert.equal(hashAction(reversed), goldenHash);
});

test("authorize_request signs the shared golden request and records its nonce", async (t) => {
  freezeClock(t);
  // The module imports randomBytes by name; Node only re-points such a binding
  // to a mocked builtin export after syncBuiltinESMExports().
  const randomBytes = t.mock.method(crypto, "randomBytes", (() =>
    Buffer.from(nonce.slice(2), "hex")) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  t.after(() => {
    randomBytes.mock.restore();
    syncBuiltinESMExports();
  });
  const ledger = createRequestLedger();

  const result = await authorizeRequest(
    account,
    apiBaseUrl,
    ledger,
    goldenRequest,
  );

  assert.deepEqual(result, {
    headers: { [WALLET_AUTHORIZATION_HEADER]: goldenAuthorization },
    expiresAt: new Date((now / 1000 + 300) * 1000).toISOString(),
  });
  assert.equal(ledger.isIssued(nonce, now / 1000), true);
  // Stamps outlive the authorization by the API's 10-minute stamp lifetime.
  assert.equal(ledger.isIssued(nonce, now / 1000 + 300 + 599), true);
  assert.equal(ledger.isIssued(nonce, now / 1000 + 300 + 600), false);
});

test("authorize_request only signs requests to the configured API", async () => {
  const ledger = createRequestLedger();
  for (const url of [
    "https://attacker.example/api/v1/bridge/execute",
    "http://chainhilt.ai/api/v1/bridge/execute",
    "https://chainhilt.ai/other/bridge/execute",
    "https://chainhilt.ai/api/v10/bridge/execute",
  ]) {
    await assert.rejects(
      authorizeRequest(account, apiBaseUrl, ledger, { url, method: "POST" }),
      /only signs requests to/,
    );
  }
});

test("an issued action asks the API with the hash the wallet computed", async (t) => {
  freezeClock(t);
  const api = createApi({ valid: true });
  const post = t.mock.method(api, "post");

  const hash = await verifyAction(api, action, {
    address: account.address,
    ledger: issuedLedger(),
  });

  assert.equal(hash, goldenHash);
  assert.deepEqual(
    post.mock.calls.map(({ arguments: args }) => args),
    [
      [
        ACTION_VERIFICATION_PATH,
        {
          hash: goldenHash,
          expiresAt: action.verification.expiresAt,
          subject: action.verification.subject,
          nonce,
          tag: action.verification.tag,
        },
      ],
    ],
  );
});

test("actions for another wallet, another request, or already run are refused without asking the API", async (t) => {
  freezeClock(t);
  const api = createApi({ valid: true });
  const post = t.mock.method(api, "post");
  const wallet = { address: account.address, ledger: issuedLedger() };

  await assert.rejects(
    verifyAction(
      api,
      {
        ...action,
        verification: {
          ...action.verification,
          subject: `0x${"99".repeat(20)}`,
        },
      },
      wallet,
    ),
    /requested for another wallet/,
  );
  await assert.rejects(
    verifyAction(api, action, { ...wallet, ledger: createRequestLedger() }),
    /does not come from a request this wallet authorized/,
  );
  wallet.ledger.markExecuted(nonce, goldenHash);
  await assert.rejects(verifyAction(api, action, wallet), /already executed/);
  assert.equal(post.mock.callCount(), 0);
});

test("changed or expired actions are refused without asking the API", async (t) => {
  freezeClock(t);
  const api = createApi({ valid: true });
  const post = t.mock.method(api, "post");
  const wallet = { address: account.address, ledger: issuedLedger() };

  await assert.rejects(
    verifyAction(
      api,
      {
        ...action,
        data: { ...action.data, nonce: (action.data.nonce as number) + 1 },
      },
      wallet,
    ),
    /does not match the one ChainHilt issued/,
  );
  t.mock.timers.setTime(action.verification.expiresAt * 1000);
  await assert.rejects(verifyAction(api, action, wallet), /expired/);
  assert.equal(post.mock.callCount(), 0);
});

test("actions the API does not vouch for are refused and released", async (t) => {
  freezeClock(t);
  const wallet = { address: account.address, ledger: issuedLedger() };
  await assert.rejects(
    verifyAction(
      createApi({ valid: false, reason: "not_issued" }),
      action,
      wallet,
    ),
    /did not issue this action \(not_issued\)/,
  );
  // The refusal released the reservation, so the same action can be verified
  // again; a successful verification keeps it reserved.
  assert.equal(
    await verifyAction(createApi({ valid: true }), action, wallet),
    goldenHash,
  );
  await assert.rejects(
    verifyAction(createApi({ valid: true }), action, wallet),
    /already executed or is being executed/,
  );
  // A malformed reply is a refusal too (and releases, like any other failure).
  const fresh = { address: account.address, ledger: issuedLedger() };
  await assert.rejects(
    verifyAction(createApi({ ok: true }), action, fresh),
    /invalid_union|Invalid input/,
  );
  assert.equal(fresh.ledger.reserve(nonce, goldenHash), true);
});
