import { randomBytes } from "node:crypto";
import { keccak256, stringToHex, toHex, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { ApiAction, ApiClient, Json, RequestLedger } from "./types.js";
import { verifyResponseSchema } from "./validation.js";

// Agents discover many x402 services, and any of them can return actions
// shaped like ChainHilt's, including actions relayed from ChainHilt that
// someone else requested for this wallet's address. So the agent first has
// this wallet sign the exact request it is about to send (authorize_request),
// and ChainHilt stamps the actions in the response with this wallet and the
// signed nonce. The wallet executes an action only when the stamp names this
// wallet and a nonce it issued, the hash it computes itself matches, the
// action has not run before, and the configured API confirms the stamp.

export const ACTION_VERIFICATION_PATH = "/actions/verify";
export const WALLET_AUTHORIZATION_HEADER = "X-ChainHilt-Authorization";
export const REQUEST_AUTHORIZATION_TTL_SECONDS = 300;
// How long the API's stamps stay valid after the request.
const STAMP_TTL_SECONDS = 600;

// Copy of the API's REQUEST_AUTHORIZATION_TYPED_DATA
// (app/api/v1/actionVerification.ts); the golden vector shared by both test
// suites keeps the two in step.
const REQUEST_AUTHORIZATION_TYPED_DATA = {
  domain: { name: "ChainHilt", version: "1" },
  types: {
    ChainHiltRequest: [
      { name: "method", type: "string" },
      { name: "path", type: "string" },
      { name: "bodyHash", type: "bytes32" },
      { name: "nonce", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
    ],
  },
  primaryType: "ChainHiltRequest",
} as const;

// Copy of the API's canonical hash: sorted keys at every depth. The golden
// vector shared by both test suites keeps the two in step.
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const members = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashAction(action: Json): Hex {
  if (action === null || typeof action !== "object" || Array.isArray(action)) {
    throw new Error("Expected an action object");
  }
  const unstamped = Object.fromEntries(
    Object.entries(action).filter(([key]) => key !== "verification"),
  );
  return keccak256(stringToHex(canonicalJson(unstamped)));
}

// Nonces this wallet signed in authorize_request, and the actions run or in
// flight under each. In memory only: after a restart, request the actions
// again.
export function createRequestLedger(): RequestLedger {
  const requests = new Map<
    string,
    { keepUntil: number; executed: Set<string>; pending: Set<string> }
  >();
  return {
    issue(nonce, expiresAt) {
      requests.set(nonce, {
        keepUntil: expiresAt + STAMP_TTL_SECONDS,
        executed: new Set(),
        pending: new Set(),
      });
    },
    isIssued(nonce, nowSeconds) {
      for (const [issued, { keepUntil }] of requests) {
        if (keepUntil <= nowSeconds) requests.delete(issued);
      }
      return requests.has(nonce);
    },
    reserve(nonce, hash) {
      const request = requests.get(nonce);
      if (
        !request ||
        request.executed.has(hash) ||
        request.pending.has(hash)
      ) {
        return false;
      }
      request.pending.add(hash);
      return true;
    },
    release(nonce, hash) {
      requests.get(nonce)?.pending.delete(hash);
    },
    markExecuted(nonce, hash) {
      const request = requests.get(nonce);
      request?.pending.delete(hash);
      request?.executed.add(hash);
    },
  };
}

export async function authorizeRequest(
  account: PrivateKeyAccount,
  apiBaseUrl: string,
  ledger: RequestLedger,
  request: { url: string; method: string; body?: Json },
) {
  const { header, nonce, expiresAt } = await signRequestAuthorization(
    account,
    apiBaseUrl,
    request,
  );
  ledger.issue(nonce, expiresAt);

  return {
    headers: { [WALLET_AUTHORIZATION_HEADER]: header },
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

// The signed header itself. A lookup of the wallet's own actions is signed
// this way too, without issuing a nonce, since nothing is executed under it.
export async function signRequestAuthorization(
  account: PrivateKeyAccount,
  apiBaseUrl: string,
  request: { url: string; method: string; body?: Json },
): Promise<{ header: string; nonce: Hex; expiresAt: number }> {
  const url = new URL(request.url);
  const base = new URL(apiBaseUrl);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)
  ) {
    throw new Error(`authorize_request only signs requests to ${apiBaseUrl}`);
  }

  const nonce = toHex(randomBytes(32));
  const expiresAt = Math.floor(Date.now() / 1000) + REQUEST_AUTHORIZATION_TTL_SECONDS;
  const bodyHash = keccak256(
    stringToHex(request.body === undefined ? "" : canonicalJson(request.body)),
  );
  const signature = await account.signTypedData({
    ...REQUEST_AUTHORIZATION_TYPED_DATA,
    message: {
      method: request.method.toUpperCase(),
      path: `${url.pathname}${url.search}`,
      bodyHash,
      nonce,
      expiresAt: BigInt(expiresAt),
    },
  });
  return {
    header: `${account.address}.${nonce}.${expiresAt}.${signature}`,
    nonce,
    expiresAt,
  };
}

// Returns the hash the wallet computed, for single-use bookkeeping.
export async function verifyAction(
  api: ApiClient,
  action: ApiAction,
  wallet: { address: string; ledger: RequestLedger },
): Promise<Hex> {
  const nowMs = Date.now();
  const { expiresAt, subject, nonce, tag } = action.verification;
  if (subject !== wallet.address.toLowerCase()) {
    throw new Error(
      `This action was requested for another wallet (${subject}). The wallet only executes actions from requests it authorized.`,
    );
  }
  if (!wallet.ledger.isIssued(nonce, Math.floor(nowMs / 1000))) {
    throw new Error(
      "This action does not come from a request this wallet authorized, or has expired. Request actions with the header from authorize_request; actions relayed from any other service are refused. After a wallet restart, request the actions again.",
    );
  }
  const hash = hashAction(action);
  if (hash !== action.verification.hash) {
    throw new Error(
      "Action does not match the one ChainHilt issued. Pass actions to process_action exactly as the API returned them, including verification.",
    );
  }
  if (expiresAt * 1000 <= nowMs) {
    throw new Error(
      `Action expired at ${new Date(expiresAt * 1000).toISOString()}. Request fresh actions from the API.`,
    );
  }
  // Reserved before the first await, released if the API does not vouch for
  // it; the caller marks it executed or releases it with the rest of the batch.
  if (!wallet.ledger.reserve(nonce, hash)) {
    throw new Error(
      "This action was already executed or is being executed. Request fresh actions to repeat the operation.",
    );
  }
  try {
    const result = verifyResponseSchema.parse(
      await api.post(ACTION_VERIFICATION_PATH, {
        hash,
        expiresAt,
        subject,
        nonce,
        tag,
      }),
    );
    if (!result.valid) {
      throw new Error(
        `The configured ChainHilt API did not issue this action (${result.reason}). The wallet only executes actions returned by that API; actions from other services are refused.`,
      );
    }
  } catch (error) {
    wallet.ledger.release(nonce, hash);
    throw error;
  }
  return hash;
}
