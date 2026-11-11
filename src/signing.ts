import { parseSignature, type Hex } from "viem";
import { PrivateKeyAccount } from "viem/accounts";
import type {
  Signature,
  TypedDataPayload,
  SignatureApiAction,
  SignedExchangePayload,
} from "./types.js";

export async function createSignedTypedDataActionPayload(
  account: PrivateKeyAccount,
  actionData: Omit<SignatureApiAction["data"], "typedData">,
  typedData: TypedDataPayload,
): Promise<SignedExchangePayload> {
  const signatureHex = await account.signTypedData(typedData);

  return {
    ...actionData,
    signature: splitSignature(signatureHex),
  };
}

function splitSignature(signature: Hex): Signature {
  const parsed = parseSignature(signature);
  const yParity = parsed.yParity ?? (parsed.v === 28n ? 1 : 0);

  return {
    r: parsed.r,
    s: parsed.s,
    v: yParity + 27,
  };
}
