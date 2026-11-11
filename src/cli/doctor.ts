import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import packageJSON from "../../package.json" with { type: "json" };
import { readConfig } from "../install.js";
import { print, selectClients, type CliOptions } from "./common.js";
import { mcpStatusContentSchema, mcpStatusSchema } from "./validation.js";
import { type ServerCommand } from "../types.js";

export async function runDoctor(options: CliOptions) {
  const targets = selectClients(options.client);
  const checks = [];
  for (const target of targets) {
    let registration;

    // Inspect client config
    try {
      registration = readConfig(target);
    } catch (error) {
      checks.push({
        client: target.id,
        installed: false,
        connected: false,
        error: error instanceof Error ? error.message : String(error),
        nextStep: `Fix ${target.config}, then run chainhilt init --client ${target.id}.`,
      });
      continue;
    }
    if (!registration) {
      checks.push({
        client: target.id,
        installed: false,
        connected: false,
        nextStep: `Run chainhilt init --client ${target.id}`,
      });
      continue;
    }

    // Inspect MCP from the client
    try {
      checks.push({
        client: target.id,
        installed: true,
        ...(await probeServer(registration)),
      });
    } catch (error) {
      checks.push({
        client: target.id,
        installed: true,
        connected: false,
        error: error instanceof Error ? error.message : String(error),
        nextStep:
          "The server did not start. Fix the error above, then run chainhilt doctor again.",
      });
    }
  }
  if (!targets.length || checks.some((check) => !check.connected)) {
    process.exitCode = 1;
  }

  print(
    {
      node: process.versions.node,
      checks,
      nextStep: targets.length
        ? "Reload the client if its active session has not picked up the registration."
        : "Run chainhilt init --client <name>.",
    },
    !!options.json,
  );
}

export async function probeServer(command: ServerCommand, timeout = 15_000) {
  const client = new Client({
    name: "chainhilt-doctor",
    version: packageJSON.version,
  });
  // Like MCP clients, rely on a minimal inherited env so shell exports don't mask the registration.
  const transport = new StdioClientTransport({ ...command, stderr: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        const { tools } = await client.listTools();
        if (!tools.some((tool) => tool.name === "mcp_status")) {
          throw new Error("Connected server does not expose mcp_status.");
        }
        const result = await client.callTool({
          name: "mcp_status",
          arguments: {},
        });
        if (result.isError) {
          throw new Error("mcp_status reported an error.");
        }
        const content = mcpStatusContentSchema.parse(result.content);
        const status = mcpStatusSchema.parse(
          JSON.parse(
            content.find((item) => item.type === "text")?.text || "{}",
          ),
        );
        return {
          connected: true,
          tools: tools.map((tool) => tool.name),
          ...status,
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "MCP connection timed out. Check the registered runtime and package availability.",
              ),
            ),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await client.close();
  }
}
