#!/usr/bin/env node
import { stderr } from "node:process";
import { Command, CommanderError } from "commander";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import packageJSON from "../package.json" with { type: "json" };
import { CLIENT_IDS, MANUAL_CLIENT_ID } from "./common.js";
import { createServer } from "./index.js";
import { CommandError, print, type CliOptions } from "./cli/common.js";
import { runInit } from "./cli/init.js";
import { runDoctor } from "./cli/doctor.js";
import { runWalletSetup } from "./cli/wallet.js";
import { migrateKeyFile } from "./wallet.js";

const program = new Command()
  .name(Object.keys(packageJSON.bin)[0])
  .description(packageJSON.description)
  .version(packageJSON.version, "-v, --version")
  .option("--json", "Print machine-readable results")
  .option("--non-interactive", "Disable interactive prompts")
  .configureHelp({ showGlobalOptions: true })
  .configureOutput({ writeErr: () => {} })
  .exitOverride()
  .hook("preAction", () => {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 19)) {
      throw new CommandError(
        "ChainHilt requires Node.js 22.19 or newer. Install Node from https://nodejs.org.",
      );
    }
  });

program
  .command("mcp", { isDefault: true })
  .description("Start the wallet MCP server over stdio")
  .action(() => {
    // Not awaited, since a locked keychain can hold it at an unlock prompt.
    // Until it finishes, and after any failure, the key file stays in use.
    const keyNotice = migrateKeyFile().then(
      (notice) => {
        if (notice) console.error(notice);
        return notice;
      },
      (error: unknown) => {
        console.error(
          `The wallet key file was not moved to the OS keychain: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      },
    );
    serveStdio(() => createServer(keyNotice));
  });

const init = program
  .command("init")
  .description("Install the wallet MCP and offer private wallet setup")
  .option(
    "--client <name...>",
    `Clients: ${[...CLIENT_IDS, MANUAL_CLIENT_ID].join(", ")}`,
  )
  .option("--all", "Configure all detected clients")
  .option("--skip-setup", "Install without opening wallet setup")
  .option("--local", "Register this local build")
  .action((_options: CliOptions, command: Command) =>
    runInit(command.optsWithGlobals<CliOptions>()),
  );

program
  .command("doctor")
  .description("Check client registration and MCP connectivity")
  .option("--client <name...>", `Clients: ${CLIENT_IDS.join(", ")}`)
  .action((_options: CliOptions, command: Command) =>
    runDoctor(command.optsWithGlobals<CliOptions>()),
  );

const wallet = program
  .command("wallet")
  .description("Set up a wallet, display its receive QR code or back it up");

const setup = wallet
  .command("setup")
  .description(
    "Import or create a wallet privately, or view its receive details",
  )
  .action((_options: CliOptions, command: Command) =>
    runWalletSetup(command.optsWithGlobals<CliOptions>()),
  );

for (const command of [init, setup]) {
  command
    .option("--terminal", "Use private interactive terminal setup")
    .option("--chain-id <id>", "Select the receive network")
    .option("--no-open", "Print the setup link without opening a browser");
}

// Claude Desktop's built-in Node is Electron, where commander's auto-detection would treat this script's path as an argument.
program.parseAsync(process.argv, { from: "node" }).catch((error: unknown) => {
  if (error instanceof CommanderError && error.exitCode === 0) return;
  const message =
    error instanceof CommandError || error instanceof CommanderError
      ? error.message
      : "ChainHilt command failed. Check arguments, wallet configuration and directory access. Run --help for usage.";
  if (process.argv.includes("--json")) print({ error: message }, true);
  else stderr.write(`${message}\n`);
  process.exitCode = 1;
});
