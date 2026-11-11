import z from "zod";

export const mcpStatusContentSchema = z.array(
  z.object({ type: z.string(), text: z.string().optional() }),
);
export const mcpStatusSchema = z.object({
  walletAddress: z.string().nullable().optional(),
  configured: z.boolean(),
  apiBaseUrl: z.string(),
  keyStorage: z.enum(["keychain", "file", "env"]).nullable().optional(),
  warning: z.string().optional(),
});

export const chainIdSchema = z.coerce.number().int().positive();
