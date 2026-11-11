import type { Address, Chain, Hash, Hex, PrivateKeyAccount } from "viem";
import {
  actionSchema,
  serverSchema,
  setupInputSchema,
  signatureActionSchema,
  transactionActionSchema,
} from "./validation.js";
import z from "zod";
import { CLIENT_IDS } from "./common.js";

type Token = {
  name: string;
  address: Address;
  decimals: number;
};

export type ChainConfig = {
  chain: Chain;
  chainId: number;
  tokens: Token[];
  rpcUrl: string | undefined;
};

export type McpConfig = {
  apiBaseUrl: string;
  activeChainConfig: ChainConfig;
  chainConfigs: ChainConfigMap;
  account: PrivateKeyAccount;
};

export type WalletConfig = Omit<McpConfig, "account"> & {
  account?: McpConfig["account"];
};

export type ChainConfigMap = Map<ChainConfig["chainId"], ChainConfig>;

export type ApiClient = {
  get<T>(path: string, headers?: Record<string, string>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
};

export type SignatureApiAction = z.infer<typeof signatureActionSchema>;
export type TransactionApiAction = z.infer<typeof transactionActionSchema>;
export type ApiAction = z.infer<typeof actionSchema>;

export type Signature = {
  r: Hex;
  s: Hex;
  v: number;
};

export type TypedDataPayload = SignatureApiAction["data"]["typedData"];

export type SignedExchangePayload = Omit<
  SignatureApiAction["data"],
  "typedData"
> & {
  signature: Signature;
};

export type ExecutedApiAction =
  | {
      type: "signature";
      // Any venue: the API owns the protocol-specific steps.
      protocol: string;
      signedPayload: SignedExchangePayload;
      submitted?: unknown;
    }
  | {
      type: "transaction";
      action: ApiAction;
      receipt: {
        from: Address;
        to: Address;
        transactionHash: Hash;
        gasUsed: string;
        blockNumber: string;
      };
    }
  | {
      type: "transaction";
      action: ApiAction;
      skipped: string;
    };

export type FailedAction = { failedAtAction: ApiAction; error: string };

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json | undefined };

export type RequestLedger = {
  issue(nonce: Hex, expiresAt: number): void;
  isIssued(nonce: string, nowSeconds: number): boolean;
  // Claims an action for one process_action call; false when it already ran
  // or another call holds it. Synchronous, so two calls that arrive together
  // cannot both pass before either marks the action as executed.
  reserve(nonce: string, hash: string): boolean;
  release(nonce: string, hash: string): void;
  markExecuted(nonce: string, hash: string): void;
};

type ClientId = (typeof CLIENT_IDS)[number];
export type ClientDefinition = {
  id: ClientId;
  config: string;
  detectDir: string;
  format: "json" | "toml" | "yaml" | "json5";
  section: string[];
  // Omitted for clients without a documented skills folder.
  skill?: string;
  reload: string;
  // For clients whose server entry differs from { command, args, env }.
  entryFormatter?: EntryFormatter;
};

export type ServerCommand = z.infer<typeof serverSchema>;

export type ConfigEntry = Record<string, unknown>;
export type EntryFormatter = {
  write: (command: ServerCommand, existing: ConfigEntry) => ConfigEntry;
  read: z.ZodType<ServerCommand>;
};

export type InputSchema = z.infer<typeof setupInputSchema>;

export type KeyStorage = "keychain" | "file" | "env";

export type WalletSetupSession = {
  token: Buffer;
  origin: string;
  expiresAt: number;
  config: WalletConfig;
  chain: ChainConfig;
};
