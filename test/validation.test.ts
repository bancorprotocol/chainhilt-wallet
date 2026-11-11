import assert from "node:assert/strict";
import test from "node:test";

import { actionSchema } from "../src/validation.js";
import { ApiAction } from "../src/types.js";

const verification = {
  hash: `0x${"ab".repeat(32)}`,
  expiresAt: 1790000000,
  subject: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
  nonce: `0x${"12".repeat(32)}`,
  tag: `0x${"cd".repeat(32)}`,
};

test("actionSchema accepts API-provided Hyperliquid signature actions", () => {
  const action: ApiAction = {
    chainId: 42161,
    protocol: "hyperliquid",
    data: {
      nonce: 1788105951789,
      orderId: 12345,
      routingHint: "api-owned-extra-field",
      action: {
        type: "order",
        orders: [
          {
            a: 0,
            b: true,
            p: "60000",
            s: "0.00016667",
            r: false,
            t: {
              limit: {
                tif: "Gtc",
              },
            },
          },
        ],
        grouping: "na",
      },
      typedData: {
        domain: {
          chainId: 1337,
          name: "Exchange",
          verifyingContract: "0x0000000000000000000000000000000000000000",
          version: "1",
        },
        message: {
          connectionId:
            "0x186fcf80a1503dbb6eb19884dcb5a5ada21bd3dd7671489f94680ff229f0295f",
          source: "a",
        },
        primaryType: "Agent",
        types: {
          Agent: [
            {
              name: "source",
              type: "string",
            },
            {
              name: "connectionId",
              type: "bytes32",
            },
          ],
          EIP712Domain: [
            {
              name: "name",
              type: "string",
            },
            {
              name: "version",
              type: "string",
            },
            {
              name: "chainId",
              type: "uint256",
            },
            {
              name: "verifyingContract",
              type: "address",
            },
          ],
        },
      },
    },
    submitPath: "/perp/hyperliquid/order/place/execute",
    type: "signature",
    verification,
  };

  const parsed = actionSchema.safeParse(action);

  assert.strictEqual(parsed?.error?.issues, undefined);
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.type, "signature");
    assert.equal(parsed.data.data.nonce, 1788105951789);
    assert.equal(parsed.data.data.orderId, 12345);
    assert.equal(parsed.data.data.routingHint, "api-owned-extra-field");
  }
});

test("actionSchema accepts API-provided Hyperliquid transaction actions", () => {
  const action: ApiAction = {
    type: "transaction",
    chainId: 8453,
    data: {
      from: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
      to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      data: "0x095ea7b300000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5d000000000000000000000000000000000000000000000000000000000012fca9",
      value: "0",
    },
    verification,
  };

  const parsed = actionSchema.safeParse(action);

  assert.strictEqual(parsed?.error?.issues, undefined);
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.type, "transaction");
    assert.equal(parsed.data.data.value, "0");
    assert.equal(
      parsed.data.data.to,
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    );
  }
});

test("actionSchema refuses actions without a verification stamp or with unknown fields", () => {
  const action = {
    type: "transaction",
    chainId: 8453,
    data: {
      from: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
      to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      data: "0x",
      value: "0",
    },
    verification,
  };
  assert.equal(actionSchema.safeParse(action).success, true);

  const { verification: _, ...unstamped } = action;
  for (const candidate of [
    unstamped,
    { ...action, verification: { ...verification, tag: "0x12" } },
    { ...action, verification: { ...verification, subject: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" } },
    { ...action, verification: { ...verification, nonce: undefined } },
    { ...action, verification: { ...verification, hash: verification.hash.toUpperCase() } },
    { ...action, beneficiary: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    { ...action, data: { ...action.data, gas: "21000" } },
  ]) {
    assert.equal(actionSchema.safeParse(candidate).success, false);
  }
});

test("actionSchema refuses typed data with unknown top-level keys", () => {
  const action = {
    type: "signature",
    chainId: 1337,
    protocol: "hyperliquid",
    submitPath: "/perp/hyperliquid/order/place/execute",
    data: {
      nonce: 1788105951789,
      typedData: {
        domain: { name: "Exchange", version: "1", chainId: 1337 },
        types: { Agent: [{ name: "source", type: "string" }] },
        primaryType: "Agent",
        message: { source: "a" },
      },
    },
    verification,
  };
  assert.equal(actionSchema.safeParse(action).success, true);

  // Refused at parse, like an unknown envelope field, not silently stripped.
  const extended = {
    ...action,
    data: { ...action.data, typedData: { ...action.data.typedData, extra: "x" } },
  };
  assert.equal(actionSchema.safeParse(extended).success, false);
});

test("actionSchema refuses a submitPath that could leave the API", () => {
  const action = {
    type: "signature",
    chainId: 1337,
    protocol: "hyperliquid",
    submitPath: "/perp/hyperliquid/order/place/execute",
    data: {
      typedData: {
        domain: { name: "Exchange", version: "1", chainId: 1337 },
        types: { Agent: [{ name: "source", type: "string" }] },
        primaryType: "Agent",
        message: { source: "a" },
      },
    },
    verification,
  };
  assert.equal(actionSchema.safeParse(action).success, true);

  for (const submitPath of [
    // With an origin-only API_BASE_URL these would name another host.
    "@evil.example/submit",
    ".evil.example/submit",
    "//evil.example/submit",
    "/../../submit",
    "/submit?next=https://evil.example",
    "/submit/",
    "",
  ]) {
    assert.equal(
      actionSchema.safeParse({ ...action, submitPath }).success,
      false,
      submitPath,
    );
  }
});
