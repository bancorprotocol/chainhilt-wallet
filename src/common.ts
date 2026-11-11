export const DEFAULT_ACTIVE_CHAIN_ID = 8453;

export const DEFAULT_API_BASE_URL = "https://chainhilt.ai/api/v1";

export const SERVER_NAME = "chainhilt-wallet";
export const CLIENT_IDS = [
  "claude-code",
  "claude-desktop",
  "codex",
  "chatgpt",
  "openclaw",
  "hermes",
  "pi",
  "cursor",
  "windsurf",
  "devin-desktop",
  "vscode",
  "antigravity",
  "zed",
  "junie",
  "gemini-cli",
  "qwen-code",
  "opencode",
  "goose",
  "cline",
  "warp",
  "openhands",
  "open-interpreter",
] as const;
// For any other client: init prints the MCP config to add instead of writing a file.
export const MANUAL_CLIENT_ID = "manual";
