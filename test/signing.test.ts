import assert from "node:assert/strict";
import test from "node:test";
import { createSignedTypedDataActionPayload } from "../src/signing.js";
import type { SignatureApiAction, TypedDataPayload } from "../src/types.js";
import { privateKeyToAccount } from "viem/accounts";

const privateKey =
  "0x0000000000000000000000000000000000000000000000000000000000000001";

test("createSignedTypedDataActionPayload signs API-provided L1 typed data", async () => {
  const account = privateKeyToAccount(privateKey);
  const typedData: TypedDataPayload = {
    domain: {
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: {
      source: "a",
      connectionId:
        "0x19789a5268a98ef950fbe4698b7b9864569fedcc92f0a844d82162bcf35a8e1a",
    },
  };
  const actionData: Omit<SignatureApiAction["data"], "typedData"> = {
    action: {
      type: "order",
    },
    nonce: 123,
  };

  const payload = await createSignedTypedDataActionPayload(
    account,
    actionData,
    typedData,
  );

  assert.equal(payload.nonce, 123);
  assert.deepEqual(payload.action, { type: "order" });
  assert.match(payload.signature.r, /^0x[a-f0-9]{64}$/);
  assert.match(payload.signature.s, /^0x[a-f0-9]{64}$/);
  assert.ok(payload.signature.v === 27 || payload.signature.v === 28);
});
