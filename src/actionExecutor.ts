import {
  BaseError,
  createWalletClient,
  decodeFunctionData,
  erc20Abi,
  EstimateGasExecutionError,
  ExecutionRevertedError,
  formatUnits,
  Hex,
  http,
  InsufficientFundsError,
  IntrinsicGasTooLowError,
  InvalidRequestRpcError,
  keccak256,
  MethodNotFoundRpcError,
  MethodNotSupportedRpcError,
  NonceTooLowError,
  numberToHex,
  publicActions,
  toFunctionSelector,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { createSignedTypedDataActionPayload } from "./signing.js";
import {
  hashAction,
  signRequestAuthorization,
  verifyAction,
  WALLET_AUTHORIZATION_HEADER,
} from "./actionVerification.js";
import type {
  ApiClient,
  ApiAction,
  McpConfig,
  ChainConfigMap,
  ExecutedApiAction,
  FailedAction,
  RequestLedger,
} from "./types.js";
import {
  actionSchema,
  signatureActionSchema,
  transactionActionSchema,
} from "./validation.js";

export async function processAction(
  api: ApiClient,
  config: McpConfig,
  ledger: RequestLedger,
  input:
    | { actions: ApiAction[]; accountAddress?: string }
    | { nonce: string; hashes: string[]; accountAddress?: string },
) {
  const { accountAddress } = input;
  const { account, chainConfigs } = config;
  if (
    !!accountAddress &&
    account.address.toLowerCase() !== accountAddress.toLowerCase()
  ) {
    throw new Error(
      "Account address for actions does not match wallet address",
    );
  }
  const actions =
    "actions" in input
      ? input.actions
      : await fetchActions(api, config, input.nonce, input.hashes);
  return executeApiActions(api, account, ledger, actions, chainConfigs);
}

// Actions by their verification hash and the nonce of the request they were
// returned to, fetched from the API that issued them, so the agent never
// re-types calldata. Each is then verified like an inline action.
async function fetchActions(
  api: ApiClient,
  { account, apiBaseUrl }: McpConfig,
  nonce: string,
  hashes: string[],
): Promise<ApiAction[]> {
  return Promise.all(
    hashes.map(async (hash) => {
      const path = `/actions/${nonce}/${hash}`;
      const { header } = await signRequestAuthorization(account, apiBaseUrl, {
        method: "GET",
        url: `${apiBaseUrl.replace(/\/$/, "")}${path}`,
      });
      const { action } = await api
        .get<{ action: unknown }>(path, { [WALLET_AUTHORIZATION_HEADER]: header })
        .catch((error: unknown) => {
          throw new Error(
            `Could not fetch action ${hash} (${error instanceof Error ? error.message : String(error)}). Pass the actions to process_action as the API returned them instead.`,
          );
        });
      const result = actionSchema.safeParse(action);
      if (!result.success) {
        throw new Error(
          `The API returned a malformed action for ${hash}: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
        );
      }
      const parsed = result.data;
      if (
        hashAction(parsed) !== hash.toLowerCase() ||
        parsed.verification.nonce.toLowerCase() !== nonce.toLowerCase()
      ) {
        throw new Error(`The API returned another action for ${hash}`);
      }
      return parsed;
    }),
  );
}

export async function executeApiActions(
  api: ApiClient,
  account: PrivateKeyAccount,
  ledger: RequestLedger,
  actions: ApiAction[],
  chainConfigMap: ChainConfigMap,
): Promise<{
  isError: boolean;
  executed: ExecutedApiAction[];
  failed: FailedAction | undefined;
}> {
  if (actions.length === 0) {
    throw new Error("No actions to execute");
  }

  // Verify the whole batch first: nothing is signed or sent unless every
  // action was issued by the configured API for a request this wallet
  // authorized. Each verified action stays reserved until the batch is either
  // marked executed or refused, so a duplicate in this batch or in a
  // concurrent call is refused.
  const verified: { nonce: string; hash: string }[] = [];
  for (const action of actions) {
    try {
      const hash = await verifyAction(api, action, {
        address: account.address,
        ledger,
      });
      verified.push({ nonce: action.verification.nonce, hash });
    } catch (error) {
      for (const { nonce, hash } of verified) {
        ledger.release(nonce, hash);
      }
      return {
        isError: true,
        executed: [],
        failed: { failedAtAction: action, error: errorMessage(error) },
      };
    }
  }
  // Checked before the stamps are used up, so the batch can be sent again from
  // a wallet that supports the chain.
  const unsupported = actions.find(
    (action) =>
      action.type === "transaction" && !chainConfigMap.has(action.chainId),
  );
  if (unsupported) {
    for (const { nonce, hash } of verified) {
      ledger.release(nonce, hash);
    }
    return {
      isError: true,
      executed: [],
      failed: {
        failedAtAction: unsupported,
        error: `Chain id ${unsupported.chainId} not supported.`,
      },
    };
  }

  // Used up before anything is signed or sent: a failure can come after a
  // broadcast, so a failed batch is requested again rather than retried.
  for (const { nonce, hash } of verified) {
    ledger.markExecuted(nonce, hash);
  }

  const executed: ExecutedApiAction[] = [];
  let failed: FailedAction | undefined;
  let isError = false;
  // Chains where an earlier action of this batch has confirmed.
  const confirmedChains = new Set<number>();

  for (const [index, action] of actions.entries()) {
    let lastExecutedAction: ExecutedApiAction;

    try {
      if (action.type === "signature") {
        lastExecutedAction = await executeSignatureAction(api, action, account);
      } else {
        lastExecutedAction = await executeTransactionAction(
          action,
          account,
          chainConfigMap,
          confirmedChains.has(action.chainId),
          actions[index + 1],
        );
        confirmedChains.add(action.chainId);
      }
      executed.push(lastExecutedAction);
    } catch (error) {
      isError = true;
      failed = { failedAtAction: action, error: errorMessage(error) };
      break;
    }
  }

  return { isError, executed, failed };
}

async function executeSignatureAction(
  api: ApiClient,
  rawAction: ApiAction,
  account: PrivateKeyAccount,
): Promise<ExecutedApiAction> {
  // Protocol-agnostic by design: the API owns every venue-specific step and
  // tells the wallet only what to sign and where to POST the signature.
  const actionParsingRes = signatureActionSchema.safeParse(rawAction);
  if (!actionParsingRes.success) {
    throw new Error(
      `Error parsing signature action:\n${actionParsingRes.error.issues}`,
    );
  }
  const action = actionParsingRes.data;

  if (!action.submitPath) {
    throw new Error(
      "API returned a signature action without submitPath; refusing to report a trading action as executed without submission",
    );
  }
  const { typedData, ...actionData } = action.data;
  if (!typedData) {
    throw new Error("Signature action is missing API-provided typedData");
  }

  const signedPayload = await createSignedTypedDataActionPayload(
    account,
    actionData,
    typedData,
  );
  refuseExpired(action.verification.expiresAt);
  const submitted = await api.post(action.submitPath, signedPayload);

  return {
    type: "signature",
    protocol: action.protocol,
    signedPayload,
    submitted,
  };
}

async function executeTransactionAction(
  rawAction: ApiAction,
  account: PrivateKeyAccount,
  chainConfigMap: ChainConfigMap,
  followsConfirmedAction: boolean,
  nextAction: ApiAction | undefined,
): Promise<ExecutedApiAction> {
  const actionParsingRes = transactionActionSchema.safeParse(rawAction);
  if (!actionParsingRes.success) {
    throw new Error(
      `Error parsing execution action:\n${actionParsingRes.error.issues}`,
    );
  }
  const action = actionParsingRes.data;
  const chainConfig = chainConfigMap.get(action.chainId);
  if (!chainConfig) {
    throw new Error(`Chain id ${action.chainId} not supported.`);
  }

  const walletClient = createChainClient(account, chainConfig);

  const { from, to, data, value } = action.data;

  if (from.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `From wallet ${from} does not match account address ${account.address}`,
    );
  }

  const request = { to, data: data as Hex, value: BigInt(value) };
  const skipped = await approvalAlreadyCovered(
    walletClient,
    from,
    request,
    nextAction,
    action.chainId,
  );
  if (skipped) {
    return { type: "transaction", action, skipped };
  }

  let receipt: Awaited<ReturnType<typeof broadcast>>;
  try {
    receipt = await sendTransaction(
      walletClient,
      request,
      action.chainId,
      followsConfirmedAction,
      action.verification.expiresAt,
    );
  } catch (error) {
    const unaffordable =
      causedBy(error, EstimateGasExecutionError) ||
      causedBy(error, ExecutionRevertedError) ||
      causedBy(error, InsufficientFundsError, /insufficient funds/i);
    if (!unaffordable) {
      throw error;
    }
    const shortfall = await gasShortfall(walletClient, from, request).catch(
      () => undefined,
    );
    throw shortfall ? new Error(shortfall) : error;
  }
  const { gasUsed, transactionHash, blockNumber } = receipt;

  return {
    type: "transaction",
    action,
    receipt: {
      from,
      to,
      gasUsed: gasUsed.toString(),
      transactionHash,
      blockNumber: blockNumber.toString(),
    },
  };
}

type ChainClient = ReturnType<typeof createChainClient>;
type TransactionRequest = { to: Address; data: Hex; value: bigint };

function createChainClient(
  account: PrivateKeyAccount,
  chainConfig: NonNullable<ReturnType<ChainConfigMap["get"]>>,
) {
  return createWalletClient({
    account,
    chain: chainConfig.chain,
    transport: http(chainConfig.rpcUrl),
  }).extend(publicActions);
}

// An approve the spender's allowance already covers (left by an earlier
// approval, or by a batch that failed after it) is skipped: one transaction
// fewer, which matters for quotes that expire within seconds. An approve to
// zero, which tokens such as Ethereum USDT need before a new nonzero amount,
// is skipped when there is nothing to clear or the approve after it is
// skipped too.
async function approvalAlreadyCovered(
  client: ChainClient,
  owner: Address,
  { to, data, value }: TransactionRequest,
  nextAction: ApiAction | undefined,
  chainId: number,
): Promise<string | undefined> {
  const approval = approvalOf({ to, data, value });
  if (!approval) {
    return undefined;
  }
  // An allowance that cannot be read never skips an approve.
  const allowance = await client
    .readContract({
      address: to,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, approval.spender],
    })
    .catch(() => undefined);
  if (allowance === undefined) {
    return undefined;
  }
  const nextAmount = nextApproval(nextAction, chainId, approval);
  if (approval.amount > 0n) {
    return allowance >= approval.amount
      ? "The existing allowance already covers this approval."
      : undefined;
  }
  if (allowance === 0n) {
    return "The allowance is already zero.";
  }
  return nextAmount !== undefined && allowance >= nextAmount
    ? "The existing allowance already covers the approval after it."
    : undefined;
}

function approvalOf({
  to,
  data,
  value,
}: TransactionRequest): { token: Address; spender: Address; amount: bigint } | undefined {
  if (
    value !== 0n ||
    !data.startsWith(toFunctionSelector("approve(address,uint256)"))
  ) {
    return undefined;
  }
  const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data });
  return functionName === "approve"
    ? { token: to, spender: args[0], amount: args[1] }
    : undefined;
}

// The amount of the approve right after an approve to zero for the same token
// and spender, which decides whether the reset is needed.
function nextApproval(
  next: ApiAction | undefined,
  chainId: number,
  current: { token: Address; spender: Address },
): bigint | undefined {
  const parsed = transactionActionSchema.safeParse(next);
  if (!parsed.success || parsed.data.chainId !== chainId) {
    return undefined;
  }
  const { to, data, value } = parsed.data.data;
  const approval = approvalOf({
    to,
    data: data as Hex,
    value: BigInt(value),
  });
  return approval &&
    approval.token.toLowerCase() === current.token.toLowerCase() &&
    approval.spender.toLowerCase() === current.spender.toLowerCase()
    ? approval.amount
    : undefined;
}

// When fee caps leave the estimate too little gas it reverts with no reason,
// so a failed estimate is checked against the balance: estimated without fee
// caps, could the wallet pay the value plus the gas at current fees?
async function gasShortfall(
  client: ChainClient,
  from: Address,
  { to, data, value }: TransactionRequest,
): Promise<string | undefined> {
  const [gas, fees, balance] = await Promise.all([
    client.request({
      method: "eth_estimateGas",
      params: [{ from, to, data, value: numberToHex(value) }],
    }),
    client.estimateFeesPerGas(),
    client.getBalance({ address: from }),
  ]);
  const gasCost = BigInt(gas) * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n);
  if (value + gasCost <= balance) {
    return undefined;
  }
  const { symbol, decimals } = client.chain.nativeCurrency;
  const amount = (wei: bigint) => `${formatUnits(wei, decimals)} ${symbol}`;
  return `Not enough ${symbol} for gas: the transaction sends ${amount(value)} and its gas can cost up to ${amount(gasCost)} at current fees, but the wallet holds ${amount(balance)}. Send less or add ${amount(value + gasCost - balance)}.`;
}

// Not every RPC implements eth_sendRawTransactionSync (EIP-7966); most answer
// MethodNotFound, and Alchemy's public endpoints InvalidRequest ("only core
// evm requests are allowed"). Only those answers fall back: any other failure
// (a timeout after the broadcast included) must not trigger a second send with
// a fresh nonce.
function syncSendUnsupported(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk(
      (cause) =>
        cause instanceof MethodNotFoundRpcError ||
        cause instanceof MethodNotSupportedRpcError ||
        cause instanceof InvalidRequestRpcError,
    ) !== null
  );
}

const LAG_RETRY_ATTEMPTS = 8;
const LAG_RETRY_DELAY_MS = 1_000;
const RECEIPT_TIMEOUT_MS = 180_000;

// A load-balanced RPC can answer from a node behind the block that confirmed
// an earlier action of the batch, typically an approval: preparing the next
// transaction then reverts, or its nonce is stale. Only those steps are
// retried, while nothing has been broadcast. A first transaction on a chain
// has nothing to wait for.
async function sendTransaction(
  client: ChainClient,
  request: TransactionRequest,
  chainId: number,
  followsConfirmedAction: boolean,
  expiresAt: number,
) {
  for (let attempt = 1; ; attempt += 1) {
    const mayRetry = followsConfirmedAction && attempt < LAG_RETRY_ATTEMPTS;
    let serialized: Hex;
    try {
      serialized = await prepareAndSign(client, request, chainId);
    } catch (error) {
      const lagging =
        causedBy(error, EstimateGasExecutionError) ||
        causedBy(error, ExecutionRevertedError);
      if (!mayRetry || !lagging) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, LAG_RETRY_DELAY_MS));
      continue;
    }
    refuseExpired(expiresAt);
    const hash = keccak256(serialized);
    try {
      return await broadcast(client, serialized, hash, expiresAt);
    } catch (error) {
      const staleNonce = causedBy(error, NonceTooLowError, /nonce too low/i);
      if (!mayRetry || !staleNonce) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, LAG_RETRY_DELAY_MS));
      // A node can call our own mined transaction's nonce stale.
      const mined = await client
        .getTransactionReceipt({ hash })
        .catch(() => undefined);
      if (mined) {
        return confirmed(mined, hash);
      }
    }
  }
}

// Stamps are checked when the batch starts, but an earlier action (an approval
// waiting for its receipt, prepare retries) can outlast a short quote; the
// provider stops honouring it at the stamp's expiry, so nothing is sent after.
function refuseExpired(expiresAt: number): void {
  if (expiresAt * 1000 <= Date.now()) {
    throw new Error(
      `Action expired at ${new Date(expiresAt * 1000).toISOString()} before it was sent. Request fresh actions from the API.`,
    );
  }
}

// An estimate fits the state it ran against; an aggregator route can need
// more by the block it lands in (OKX's ran out at 98.5% of its estimate).
const GAS_HEADROOM_PERCENT = 130n;

// The RPC fills gas, fees and nonce, and its fill can set the chain id, so a
// transaction prepared for another chain is not signed.
async function prepareAndSign(
  client: ChainClient,
  request: TransactionRequest,
  chainId: number,
): Promise<Hex> {
  const prepared = await client.prepareTransactionRequest(request);
  if (prepared.chainId !== chainId) {
    throw new Error(
      `The RPC prepared the transaction for chain ${prepared.chainId}, not ${chainId}; check RPC_URL_${chainId}`,
    );
  }
  return client.signTransaction({
    ...prepared,
    gas: (prepared.gas * GAS_HEADROOM_PERCENT) / 100n,
  });
}

// The hash is known before sending. Only an answer that the node refused the
// transaction counts as not sent; anything else (a timeout, "already known",
// a dropped connection) is followed to its receipt, and if that fails too the
// error names the hash, since sending again would use a new nonce and bridge
// twice.
async function broadcast(
  client: ChainClient,
  serialized: Hex,
  hash: Hex,
  expiresAt: number,
) {
  let sendError: unknown;
  try {
    return confirmed(
      await client.sendRawTransactionSync({ serializedTransaction: serialized }),
      hash,
    );
  } catch (error) {
    sendError = error;
  }
  if (syncSendUnsupported(sendError)) {
    // Nothing was sent, and the refusal can arrive after the stamp expired.
    refuseExpired(expiresAt);
    sendError = await client
      .sendRawTransaction({ serializedTransaction: serialized })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
  }
  if (sendError !== undefined && refusedByNode(sendError)) {
    throw sendError;
  }
  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({
      hash,
      timeout: RECEIPT_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(
      `Transaction ${hash} may have been sent (${errorMessage(error)}); check it before sending again`,
    );
  }
  return confirmed(receipt, hash);
}

function confirmed<T extends { status: string; transactionHash: Hex }>(
  receipt: T,
  hash: Hex,
): T {
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
    throw new Error(
      `Transaction ${hash} was replaced by ${receipt.transactionHash}; check both before sending again`,
    );
  }
  if (receipt.status !== "success") {
    throw new Error(`Transaction ${hash} reverted`);
  }
  return receipt;
}

// Answers that mean the node did not take the transaction. "already known"
// means it did.
function refusedByNode(error: unknown): boolean {
  if (causedBy(error, undefined, /already known|already imported/i)) {
    return false;
  }
  return (
    causedBy(error, NonceTooLowError, /nonce too low/i) ||
    causedBy(error, InsufficientFundsError, /insufficient funds/i) ||
    causedBy(
      error,
      IntrinsicGasTooLowError,
      /intrinsic gas|underpriced|fee cap|base fee|invalid sender/i,
    )
  );
}

// A raw send gets the node's error as a generic RPC error, so its text is
// matched too.
function causedBy(
  error: unknown,
  type: (abstract new (...args: never[]) => Error) | undefined,
  nodeMessage?: RegExp,
): boolean {
  return (
    error instanceof BaseError &&
    error.walk(
      (cause) =>
        (type !== undefined && cause instanceof type) ||
        (nodeMessage !== undefined &&
          cause instanceof BaseError &&
          nodeMessage.test(cause.details ?? "")),
    ) !== null
  );
}

// viem's full message lists the RPC URL, which may carry a key.
function errorMessage(error: unknown): string {
  if (error instanceof BaseError) {
    return error.details && !error.shortMessage.includes(error.details)
      ? `${error.shortMessage} ${error.details}`
      : error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}
