import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

// Reports only the env it was launched with; the real server would also load the package .env.
serveStdio(() => {
  const server = new McpServer({ name: "env-probe", version: "0.0.0" });
  server.registerTool(
    "mcp_status",
    { inputSchema: z.object({}) },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            configured: !!process.env.WALLET_PRIVATE_KEY,
            apiBaseUrl: process.env.API_BASE_URL ?? "",
          }),
        },
      ],
    }),
  );
  return server;
});
