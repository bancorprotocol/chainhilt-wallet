import { stdin, stderr } from "node:process";
import {
  keyStorageWarning,
  parsePrivateKey,
  readWallet,
  saveWallet,
} from "../wallet.js";
import { SUPPORTED_CHAIN_CONFIG_MAP } from "../chains.js";
import { startSetupSession, openBrowser } from "../setup.js";
import { CommandError, print, question, type CliOptions } from "./common.js";
import { chainIdSchema } from "./validation.js";

async function hiddenKey(): Promise<string> {
  if (!stdin.isTTY || !stdin.setRawMode) {
    throw new CommandError(
      "Private key entry requires an interactive terminal.",
    );
  }
  stderr.write("Private key (hidden): ");
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stderr.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          finish();
          reject(new CommandError("Cancelled; no wallet was created."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value.trim());
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (/[^\u0000-\u001f]/.test(character) && value.length < 1024) {
          value += character;
        }
      }
    };
    stdin.on("data", onData);
  });
}

const interactive = (options: CliOptions) =>
  !options.json && !options.nonInteractive && stdin.isTTY;

async function terminalSetup() {
  const existing = readWallet();
  if (existing) return { ...existing, reused: true };
  const mode = (
    await question("Import or create a wallet? [import/create/cancel]: ")
  )
    .trim()
    .toLowerCase();
  if (!["import", "create"].includes(mode)) {
    throw new CommandError("Cancelled; no wallet was created.");
  }
  let privateKey;
  if (mode === "import") {
    const value = await hiddenKey();
    try {
      privateKey = parsePrivateKey(value);
    } catch (error) {
      // parsePrivateKey's messages never include the key.
      throw new CommandError(
        error instanceof Error ? error.message : "Invalid private key",
      );
    }
  }
  const result = await saveWallet(privateKey);
  if (mode === "create") {
    stderr.write(
      `Back up this private key privately; it is the only way to recover the wallet:\n${result.privateKey}\n`,
    );
    await question("Press Enter after backing it up. ");
  }
  const warning = keyStorageWarning(result.keyStorage);
  return {
    address: result.address,
    keyStorage: result.keyStorage,
    ...(warning ? { warning } : {}),
  };
}

export async function runWalletSetup(options: CliOptions) {
  if (options.terminal) {
    // A created key is printed to stderr, which must not be redirected into a log.
    if (!interactive(options) || !stderr.isTTY) {
      throw new CommandError(
        "Terminal wallet setup requires an interactive terminal.",
      );
    }
    print(await terminalSetup(), false);
    return;
  }
  let chainId;
  if (options.chainId) {
    const parsed = chainIdSchema.safeParse(options.chainId);
    if (!parsed.success || !SUPPORTED_CHAIN_CONFIG_MAP.has(parsed.data)) {
      throw new CommandError(
        `Unsupported --chain-id ${options.chainId}. Supported: ${[...SUPPORTED_CHAIN_CONFIG_MAP.keys()].join(", ")}.`,
      );
    }
    chainId = parsed.data;
  }
  const session = await startSetupSession({ chainId });
  print(
    {
      url: session.url,
      expiresAt: session.expiresAt,
      instructions:
        "Open privately on this machine. On a remote host forward the same port number (ssh -L PORT:127.0.0.1:PORT); the page rejects any other port. Close with Ctrl+C; this session expires in 10 minutes.",
    },
    !!options.json,
  );
  if (options.open !== false && !options.json) {
    openBrowser(session.url);
  }
  const stop = () => session.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await session.closed;
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
