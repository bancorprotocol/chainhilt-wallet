import { stdin, stderr } from "node:process";
import select, { Separator } from "@inquirer/select";
import {
  clientDefinitions,
  installClient,
  manualInstructions,
  readConfig,
  serverCommand,
} from "../install.js";
import { MANUAL_CLIENT_ID } from "../common.js";
import { probeServer } from "./doctor.js";
import { loadConfig } from "../config.js";
import {
  CommandError,
  print,
  question,
  selectClients,
  type CliOptions,
} from "./common.js";
import { runWalletSetup } from "./wallet.js";
import { ClientDefinition, type ServerCommand } from "../types.js";

function verifyInitInput(options: CliOptions) {
  if (options.all && options.client?.length) {
    throw new CommandError("Choose --all or --client.");
  }
  if (
    (options.nonInteractive || options.json || !stdin.isTTY) &&
    !options.all &&
    !options.client?.length
  ) {
    throw new CommandError(
      "Specify --client or --all for noninteractive installation.",
    );
  }
}

async function chooseClient(
  clients: ClientDefinition[],
  detected: ClientDefinition[],
) {
  const isDetected = (client: ClientDefinition) =>
    detected.some((entry) => entry.id === client.id);
  try {
    return await select(
      {
        message: "Install ChainHilt for which agent?",
        choices: [
          ...[
            ...clients.filter(isDetected),
            ...clients.filter((client) => !isDetected(client)),
          ].map((client) => ({
            value: client.id,
            name: isDetected(client) ? `${client.id} (detected)` : client.id,
          })),
          new Separator(),
          { value: MANUAL_CLIENT_ID, name: "other (show the MCP config)" },
        ],
        default: detected[0]?.id,
        pageSize: 12,
      },
      { output: stderr },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      throw new CommandError("Installation cancelled.");
    }
    throw error;
  }
}

async function tryProbe(registration: ServerCommand) {
  try {
    return await probeServer(registration);
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : String(error),
      nextStep:
        "Registration saved, but the server did not start. Fix the error above, then run chainhilt doctor to check again.",
    };
  }
}

type Connection = Awaited<ReturnType<typeof tryProbe>>;

// Decided by the registered servers, not this shell: their saved env may hold a
// WALLET_PRIVATE_KEY this shell lacks.
export const unconfigured = (connection: Connection) =>
  connection.connected && "configured" in connection && !connection.configured;

const shouldSetupWallet = (options: CliOptions, connections: Connection[]) =>
  !options.skipSetup &&
  !options.nonInteractive &&
  !options.json &&
  stdin.isTTY &&
  connections.some(unconfigured);

export async function runInit(options: CliOptions) {
  loadConfig();
  verifyInitInput(options);
  const requested =
    options.client || options.all
      ? options.client
      : [await chooseClient(clientDefinitions(), selectClients())];
  const targets = selectClients(requested);
  const manual = requested?.includes(MANUAL_CLIENT_ID);
  if (!targets.length && !manual) {
    throw new CommandError(
      "No clients detected. Specify --client <name> with a valid name.",
    );
  }
  const command = serverCommand(options.local);
  const probes = new Map<string, Connection>();
  const installed = [];
  for (const client of targets) {
    const result = installClient(client, command);
    // Probe what the client launches: its saved entry keeps user env such as WALLET_PRIVATE_KEY.
    const registration = readConfig(client);
    if (!registration) {
      throw new CommandError(
        `Could not read back the ${client.id} registration.`,
      );
    }

    // Avoid probing clients with the same config, such as chatgpt and codex as probing is expensive
    const key = JSON.stringify(registration);
    let connection = probes.get(key);
    if (!connection) {
      connection = await tryProbe(registration);
      probes.set(key, connection);
    }
    installed.push({ ...result, connection });
  }
  const instructions = manual ? manualInstructions(command) : undefined;
  const manualConnection = manual ? await tryProbe(command) : undefined;
  print(
    {
      installed,
      ...(options.json && instructions ? { manual: instructions } : {}),
      ...(manualConnection ? { connection: manualConnection } : {}),
    },
    !!options.json,
  );
  if (!options.json && instructions) {
    const { steps, config } = instructions;
    print(
      `\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n${config}`,
    );
  }
  const connections = [
    ...probes.values(),
    ...(manualConnection ? [manualConnection] : []),
  ];
  if (!shouldSetupWallet(options, connections)) return;
  // The setup page would show this shell's wallet, which a client passes to
  // the server only if it forwards shell variables.
  if (process.env.WALLET_PRIVATE_KEY) {
    print(
      "\nWALLET_PRIVATE_KEY is set in this shell, but the registered server reports no wallet. Your client sees the key only if it passes shell variables through. Add it to the client's MCP config, or run chainhilt wallet setup without it.",
    );
    return;
  }
  const answer = await question("Open private wallet setup now? [Y/n]: ");
  if (answer.trim().toLowerCase() !== "n") await runWalletSetup(options);
}
