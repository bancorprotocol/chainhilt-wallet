import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { z } from "zod";
import { clientDefinitions, detectClients } from "../install.js";
import { CLIENT_IDS, MANUAL_CLIENT_ID } from "../common.js";

export class CommandError extends Error {}

export interface CliOptions {
  json?: boolean;
  nonInteractive?: boolean;
  client?: string[];
  all?: boolean;
  skipSetup?: boolean;
  local?: boolean;
  terminal?: boolean;
  chainId?: string;
  open?: boolean;
}

export function print(value: object | string, json = false) {
  const output =
    typeof value === "string" && !json
      ? value
      : JSON.stringify(value, null, json ? undefined : 2);
  stdout.write(`${output}\n`);
}

export async function question(message: string) {
  const prompt = createInterface({ input: stdin, output: stderr });
  try {
    return await prompt.question(message);
  } finally {
    prompt.close();
  }
}

export function selectClients(ids?: string[]) {
  const clients = clientDefinitions();
  if (!ids) return detectClients(clients);
  const requested = ids.map((id) => {
    const parsed = z.enum([...CLIENT_IDS, MANUAL_CLIENT_ID]).safeParse(id);
    if (!parsed.success) {
      throw new CommandError(
        `Choose a supported --client: ${[...CLIENT_IDS, MANUAL_CLIENT_ID].join(", ")}.`,
      );
    }
    return parsed.data;
  });
  return clients.filter((client) => requested.includes(client.id));
}
