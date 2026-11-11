import { Address } from "viem";
import z from "zod";
import { SERVER_NAME } from "./common.js";

const evmAddressPattern = /^0x[a-fA-F0-9]{40}$/;
export const evmAddressSchema = z
  .string()
  .regex(evmAddressPattern, "Expected an EVM address")
  .transform((value) => value as Address);

const bytes32Pattern = /^0x[a-f0-9]{64}$/;
const bytes32Schema = z
  .string()
  .regex(bytes32Pattern, "Expected a lowercase 32-byte hex");

// Stamp the API adds to every action it issues; see actionVerification.ts.
export const actionVerificationSchema = z.strictObject({
  hash: bytes32Schema,
  expiresAt: z.number().int().positive(),
  subject: z
    .string()
    .regex(/^0x[a-f0-9]{40}$/, "Expected a lowercase EVM address"),
  nonce: bytes32Schema,
  tag: bytes32Schema,
});

// Strict like the envelope: an unknown key is refused, not silently stripped.
export const typedDataSchema = z.strictObject({
  domain: z.record(z.string(), z.json()),
  types: z.record(z.string(), z.json()),
  primaryType: z.string(),
  message: z.record(z.string(), z.json()),
});

// Strict at the envelope: the verification hash covers every field, so an
// unknown one must be refused here rather than silently stripped.
export const signatureActionSchema = z.strictObject({
  type: z.literal("signature"),
  chainId: z.number(),
  protocol: z.string(),
  // Appended to the API base URL, so it must not be able to leave it.
  submitPath: z
    .string()
    .regex(/^(\/[A-Za-z0-9_-]+)+$/, "Expected a plain path on the API"),
  data: z
    .object({
      typedData: typedDataSchema, // -> signature
      // ... data that gets passed in the body of req to submitPath
    })
    .catchall(z.json()),
  verification: actionVerificationSchema,
});

export const transactionActionSchema = z.strictObject({
  type: z.literal("transaction"),
  chainId: z.number(),
  protocol: z.string().optional(),
  data: z.strictObject({
    from: evmAddressSchema,
    to: evmAddressSchema,
    data: z.string(),
    value: z.string(),
    nonce: z.number().optional(),
  }),
  verification: actionVerificationSchema,
});

export const actionSchema = z.discriminatedUnion("type", [
  signatureActionSchema,
  transactionActionSchema,
]);

// The API's answer to POST /actions/verify.
export const verifyResponseSchema = z.discriminatedUnion("valid", [
  z.object({ valid: z.literal(true) }),
  z.object({ valid: z.literal(false), reason: z.string() }),
]);

export const serverSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
});

export const tomlSchema = z.object({
  // Loose so user settings in the table survive the round-trip check.
  mcp_servers: z.object({ [SERVER_NAME]: serverSchema.loose() }),
});

export const setupAssetQuerySchema = z.object({
  chainId: z.coerce.number().int().positive().optional(),
  asset: z.string().optional(),
});

// ~/.chainhilt/wallet.json: no secret, so the address is known without reading the keychain.
export const walletFileSchema = z.object({
  address: evmAddressSchema,
  storage: z.literal("keychain"),
});

export const setupInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("create") }).strict(),
  z
    .object({ mode: z.literal("import"), privateKey: z.string().max(66) })
    .strict(),
]);
