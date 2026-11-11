import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  applyEdits,
  modify,
  parse as parseJson,
  type ParseError,
} from "jsonc-parser";
import {
  parse as smolParseToml,
  stringify as stringifyToml,
  TomlError,
} from "smol-toml";
import { parseDocument } from "yaml";
import { z } from "zod";
import JSON5 from "json5";
import packageJSON from "../package.json" with { type: "json" };
import { serverSchema, tomlSchema } from "./validation.js";
import { SERVER_NAME } from "./common.js";
import type {
  ClientDefinition,
  ConfigEntry,
  EntryFormatter,
  ServerCommand,
} from "./types.js";

const envSchema = z.record(z.string(), z.string());
const entrySchema = z.record(z.string(), z.unknown());
// The only env keys init writes; anything else in env belongs to the user if already defined.
const OWNED_ENV = new Set([
  "CHAINHILT_HOME",
  "API_BASE_URL",
  "ACTIVE_CHAIN_ID",
  "CHAINHILT_KEY_STORAGE",
]);

const defaultEntryFormatter: EntryFormatter = {
  write: (command, existing) => ({ ...existing, ...command }),
  read: serverSchema,
};

const vscodeEntryFormatter: EntryFormatter = {
  write: (command, existing) => ({ type: "stdio", ...existing, ...command }),
  read: serverSchema,
};

const opencodeEntryFormatter: EntryFormatter = {
  write: ({ command, args, env }, existing) => ({
    type: "local",
    enabled: true,
    ...existing,
    command: [command, ...args],
    ...(env ? { environment: env } : {}),
  }),
  read: z
    .object({
      command: z.array(z.string()).min(1),
      environment: envSchema.optional(),
    })
    .transform(({ command: [command, ...args], environment }) => ({
      command,
      args,
      ...(environment ? { env: environment } : {}),
    })),
};

const gooseEntryFormatter: EntryFormatter = {
  write: ({ command, args, env }, existing) => ({
    name: SERVER_NAME,
    type: "stdio",
    enabled: true,
    timeout: 300,
    ...existing,
    cmd: command,
    args,
    ...(env ? { envs: env } : {}),
  }),
  read: z
    .object({
      cmd: z.string(),
      args: z.array(z.string()),
      envs: envSchema.optional(),
    })
    .transform(({ cmd, args, envs }) => ({
      command: cmd,
      args,
      ...(envs ? { env: envs } : {}),
    })),
};

export function clientDefinitions(
  home = homedir(),
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ClientDefinition[] {
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  const codexSkill = env.CODEX_HOME
    ? join(codexHome, "skills", "chainhilt", "SKILL.md")
    : join(home, ".agents", "skills", "chainhilt", "SKILL.md");
  const openclawHome = env.OPENCLAW_STATE_DIR || join(home, ".openclaw");
  const openclawConfig =
    env.OPENCLAW_CONFIG_PATH || join(openclawHome, "openclaw.json");
  const hermesHome =
    env.HERMES_HOME ||
    (platform === "win32"
      ? join(home, "AppData", "Local", "hermes")
      : join(home, ".hermes"));
  const piHome = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
  const desktopHome =
    platform === "darwin"
      ? join(home, "Library", "Application Support", "Claude")
      : platform === "win32"
        ? join(home, "AppData", "Roaming", "Claude")
        : join(env.XDG_CONFIG_HOME || join(home, ".config"), "Claude");
  const skillIn = (dir: string) =>
    join(dir, "skills", "chainhilt", "SKILL.md");
  const agentsSkill = join(home, ".agents", "skills", "chainhilt", "SKILL.md");
  const xdgConfig = env.XDG_CONFIG_HOME || join(home, ".config");
  const roaming = join(home, "AppData", "Roaming");
  const vscodeUser =
    platform === "darwin"
      ? join(home, "Library", "Application Support", "Code", "User")
      : platform === "win32"
        ? join(roaming, "Code", "User")
        : join(xdgConfig, "Code", "User");
  const zedHome =
    platform === "win32"
      ? join(roaming, "Zed")
      : platform === "darwin"
        ? join(home, ".config", "zed")
        : join(xdgConfig, "zed");
  const devinHome =
    platform === "win32" ? join(roaming, "devin") : join(xdgConfig, "devin");
  const windsurfHome = join(home, ".codeium", "windsurf");
  const antigravityHome = join(home, ".gemini", "config");
  const geminiHome = join(env.GEMINI_CLI_HOME || home, ".gemini");
  const qwenHome = env.QWEN_HOME || join(home, ".qwen");
  const junieHome = env.JUNIE_HOME || join(home, ".junie");
  const opencodeHome = join(xdgConfig, "opencode");
  // OpenCode reads either name; edit the one the user already has.
  const opencodeConfig = existsSync(join(opencodeHome, "opencode.jsonc"))
    ? join(opencodeHome, "opencode.jsonc")
    : join(opencodeHome, "opencode.json");
  const gooseConfig = env.GOOSE_PATH_ROOT
    ? join(env.GOOSE_PATH_ROOT, "config", "config.yaml")
    : platform === "win32"
      ? join(roaming, "Block", "goose", "config", "config.yaml")
      : join(xdgConfig, "goose", "config.yaml");
  const clineHome = env.CLINE_DIR || join(home, ".cline");
  const clineConfig =
    env.CLINE_MCP_SETTINGS_PATH ||
    join(
      env.CLINE_DATA_DIR || join(clineHome, "data"),
      "settings",
      "cline_mcp_settings.json",
    );
  const warpHome = join(home, ".warp");
  // ~/.warp only appears on Linux and Windows once MCP or skills are set up.
  const warpDetect =
    platform === "darwin"
      ? warpHome
      : platform === "win32"
        ? join(home, "AppData", "Local", "warp", "Warp")
        : join(xdgConfig, "warp-terminal");
  const openhandsHome =
    env.OPENHANDS_PERSISTENCE_DIR || join(home, ".openhands");
  const interpreterHome =
    env.INTERPRETER_HOME || join(home, ".openinterpreter");
  return [
    {
      id: "claude-code",
      config: env.CLAUDE_CONFIG_DIR
        ? join(env.CLAUDE_CONFIG_DIR, ".claude.json")
        : join(home, ".claude.json"),
      // ~/.claude.json sits directly in home, so its dirname would always exist.
      detectDir: env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
      format: "json",
      section: ["mcpServers"],
      skill: join(
        env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
        "skills",
        "chainhilt",
        "SKILL.md",
      ),
      reload: "Start a new Claude Code session.",
    },
    {
      id: "claude-desktop",
      config: join(desktopHome, "claude_desktop_config.json"),
      detectDir: desktopHome,
      format: "json",
      section: ["mcpServers"],
      skill: join(home, ".agents", "skills", "chainhilt", "SKILL.md"),
      reload:
        "Restart Claude Desktop/Cowork. Server instructions provide the workflow; filesystem skills may not be loaded.",
    },
    {
      id: "codex",
      config: join(codexHome, "config.toml"),
      detectDir: codexHome,
      format: "toml",
      section: ["mcp_servers"],
      skill: codexSkill,
      reload: "Restart the Codex CLI/IDE session.",
    },
    {
      id: "chatgpt",
      config: join(codexHome, "config.toml"),
      detectDir: codexHome,
      format: "toml",
      section: ["mcp_servers"],
      skill: codexSkill,
      reload:
        "Restart the ChatGPT desktop MCP connection on this Codex host. Web/Dots need a supported local executor or plugin connection.",
    },
    {
      id: "openclaw",
      config: openclawConfig,
      detectDir: dirname(openclawConfig),
      format: "json5",
      section: ["mcp", "servers"],
      skill: join(openclawHome, "skills", "chainhilt", "SKILL.md"),
      reload:
        "Reload the Gateway that owns the connection; verify with openclaw mcp doctor chainhilt-wallet --probe.",
    },
    {
      id: "hermes",
      config: join(hermesHome, "config.yaml"),
      detectDir: hermesHome,
      format: "yaml",
      section: ["mcp_servers"],
      skill: join(hermesHome, "skills", "chainhilt", "SKILL.md"),
      reload: "Restart the Hermes session.",
    },
    {
      id: "pi",
      config: join(piHome, "mcp.json"),
      detectDir: piHome,
      format: "json",
      section: ["mcpServers"],
      skill: join(piHome, "skills", "chainhilt", "SKILL.md"),
      reload: "Run /reload in Pi, then /mcp to verify the connection.",
    },
    {
      id: "cursor",
      config: join(home, ".cursor", "mcp.json"),
      detectDir: join(home, ".cursor"),
      format: "json",
      section: ["mcpServers"],
      skill: skillIn(join(home, ".cursor")),
      reload:
        "Quit and reopen Cursor; reloading the window keeps the old tool list.",
    },
    {
      id: "windsurf",
      config: join(windsurfHome, "mcp_config.json"),
      detectDir: windsurfHome,
      format: "json",
      section: ["mcpServers"],
      skill: skillIn(windsurfHome),
      reload:
        "Refresh the MCP servers in the Cascade panel, or restart Windsurf.",
    },
    {
      id: "devin-desktop",
      config: join(devinHome, "mcp_config.json"),
      detectDir: devinHome,
      format: "json",
      section: ["mcpServers"],
      skill: skillIn(devinHome),
      reload:
        "Refresh the MCP servers in the Cascade panel, or restart Devin Desktop.",
    },
    {
      id: "vscode",
      config: join(vscodeUser, "mcp.json"),
      detectDir: vscodeUser,
      format: "json",
      section: ["servers"],
      skill: skillIn(join(home, ".copilot")),
      reload:
        "Run MCP: List Servers and start chainhilt-wallet, or reload the window.",
      entryFormatter: vscodeEntryFormatter,
    },
    {
      id: "antigravity",
      config: join(antigravityHome, "mcp_config.json"),
      detectDir: antigravityHome,
      format: "json",
      section: ["mcpServers"],
      skill: skillIn(antigravityHome),
      reload:
        "Open Settings > Customizations > Installed MCP Servers and click Refresh.",
    },
    {
      id: "zed",
      config: join(zedHome, "settings.json"),
      detectDir: zedHome,
      format: "json",
      section: ["context_servers"],
      skill: agentsSkill,
      reload:
        "Check Settings > AI > MCP Servers; a green dot means chainhilt-wallet is active.",
    },
    {
      id: "junie",
      config: join(junieHome, "mcp", "mcp.json"),
      detectDir: junieHome,
      format: "json",
      section: ["mcpServers"],
      skill: skillIn(junieHome),
      reload:
        "Restart Junie, then check Settings | Tools | Junie | MCP Settings or /mcp.",
    },
    {
      id: "gemini-cli",
      config: join(geminiHome, "settings.json"),
      detectDir: geminiHome,
      format: "json",
      section: ["mcpServers"],
      skill: skillIn(geminiHome),
      reload: "Run /mcp reload in Gemini CLI, or restart it.",
    },
    {
      id: "qwen-code",
      config: join(qwenHome, "settings.json"),
      detectDir: qwenHome,
      format: "json",
      section: ["mcpServers"],
      skill: skillIn(qwenHome),
      reload: "Restart Qwen Code, then check /mcp.",
    },
    {
      id: "opencode",
      config: opencodeConfig,
      detectDir: opencodeHome,
      format: "json",
      section: ["mcp"],
      skill: skillIn(opencodeHome),
      reload: "Restart OpenCode.",
      entryFormatter: opencodeEntryFormatter,
    },
    {
      id: "goose",
      config: gooseConfig,
      detectDir: dirname(gooseConfig),
      format: "yaml",
      section: ["extensions"],
      skill: agentsSkill,
      reload: "Start a new goose session, or restart Goose Desktop.",
      entryFormatter: gooseEntryFormatter,
    },
    {
      id: "cline",
      config: clineConfig,
      detectDir: clineHome,
      format: "json",
      section: ["mcpServers"],
      skill: skillIn(clineHome),
      reload:
        "The Cline extension reconnects automatically; restart the Cline CLI.",
    },
    {
      id: "warp",
      config: join(warpHome, ".mcp.json"),
      detectDir: warpDetect,
      format: "json",
      section: ["mcpServers"],
      skill: skillIn(warpHome),
      reload:
        "Start chainhilt-wallet from Settings > Agents > MCP servers, or restart Warp.",
    },
    {
      id: "openhands",
      config: join(openhandsHome, "mcp.json"),
      detectDir: openhandsHome,
      format: "json",
      section: ["mcpServers"],
      reload: "Start a new OpenHands conversation, or restart the CLI.",
    },
    {
      id: "open-interpreter",
      config: join(interpreterHome, "config.toml"),
      detectDir: interpreterHome,
      format: "toml",
      section: ["mcp_servers"],
      reload: "Restart interpreter, then check /mcp.",
    },
  ];
}

export function manualInstructions(command: ServerCommand) {
  return {
    steps: [
      `Add the ${SERVER_NAME} server below to your agent's MCP configuration (usually under mcpServers).`,
      "Restart or reload the agent, then call mcp_status to confirm the wallet is connected.",
    ],
    config: JSON.stringify({ mcpServers: { [SERVER_NAME]: command } }, null, 2),
  };
}

export function detectClients(clients = clientDefinitions()) {
  return clients.filter(
    (client) => existsSync(client.config) || existsSync(client.detectDir),
  );
}

export function serverCommand(
  local = false,
  platform = process.platform,
): ServerCommand {
  const env = {
    ...(process.env.CHAINHILT_HOME
      ? { CHAINHILT_HOME: resolve(process.env.CHAINHILT_HOME) }
      : {}),
    ...(process.env.API_BASE_URL
      ? { API_BASE_URL: process.env.API_BASE_URL }
      : {}),
    ...(process.env.ACTIVE_CHAIN_ID
      ? { ACTIVE_CHAIN_ID: process.env.ACTIVE_CHAIN_ID }
      : {}),
    // Otherwise the registered server would move a deliberately kept key file into the keychain.
    ...(process.env.CHAINHILT_KEY_STORAGE
      ? { CHAINHILT_KEY_STORAGE: process.env.CHAINHILT_KEY_STORAGE }
      : {}),
  };
  if (local) {
    return {
      command: process.execPath,
      args: [fileURLToPath(new URL("./cli.js", import.meta.url)), "mcp"],
      env,
    };
  }
  const args = ["-y", `chainhilt@${packageJSON.version}`, "mcp"];
  return platform === "win32"
    ? { command: "cmd.exe", args: ["/d", "/c", "npx", ...args], env }
    : { command: "npx", args, env };
}

function jsonDocument(source: string, json5 = false) {
  const errors: ParseError[] = [];
  const document: unknown = parseJson(source || "{}", errors, {
    allowTrailingComma: true,
  });
  if (errors.length && !json5) {
    throw new Error(
      "Malformed client configuration; fix it before installation (JSON with comments/trailing commas is supported).",
    );
  }
  return z
    .record(z.string(), z.json())
    .parse(errors.length ? JSON5.parse(source) : document);
}

function parseToml(source: string) {
  try {
    return smolParseToml(source);
  } catch (error) {
    // smol-toml quotes the surrounding lines, which can hold keys kept in env.
    if (error instanceof TomlError) {
      throw new Error(
        `Malformed TOML client configuration at line ${error.line}, column ${error.column}`,
      );
    }
    throw error;
  }
}

function readEntry(client: ClientDefinition): unknown {
  if (!existsSync(client.config)) return undefined;
  const source = readFileSync(client.config, "utf8");

  let document: unknown;
  if (client.format === "toml") {
    document = parseToml(source);
  } else if (client.format === "yaml") {
    const yaml = parseDocument(source, { uniqueKeys: true });
    if (yaml.errors.length)
      throw new Error("Malformed YAML client configuration");
    document = yaml.toJS();
  } else {
    document = jsonDocument(source, client.format === "json5");
  }

  for (const key of [...client.section, SERVER_NAME]) {
    if (!document || typeof document !== "object" || !(key in document))
      return undefined;
    document = (document as Record<string, unknown>)[key];
  }
  return document;
}

export function readConfig(
  client: ClientDefinition,
): ServerCommand | undefined {
  const entry = readEntry(client);
  return entry === undefined
    ? undefined
    : (client.entryFormatter ?? defaultEntryFormatter).read.parse(entry);
}

function writeConfig(path: string, next: string) {
  const exists = existsSync(path);
  // Write through symlinks so configs kept in dotfiles stay linked.
  const target = exists ? realpathSync(path) : path;
  const previous = exists ? readFileSync(target, "utf8") : undefined;
  if (previous === next) return;
  mkdirSync(dirname(target), { recursive: true });
  // The backup only outlives a failed write, so configs and their secrets are not copied around.
  const backup = `${target}.chainhilt-${randomUUID()}.bak`;
  if (previous !== undefined)
    writeFileSync(backup, previous, { flag: "wx", mode: 0o600 });
  const temporary = `${target}.chainhilt-${randomUUID()}.tmp`;
  writeFileSync(temporary, next, { flag: "wx", mode: 0o600 });
  // chmod after creation so the umask cannot narrow an existing file's mode.
  if (exists) {
    chmodSync(temporary, statSync(target).mode & 0o777);
  }
  renameSync(temporary, target);
  rmSync(backup, { force: true });
}

// A header line parses as TOML on its own, so spacing, quoting and escapes are normalized.
function isOwnedTomlTable(section: string) {
  const [header] = section.trimStart().split(/\r?\n/, 1);
  // The root section can start with a dotted key, which must not drop it.
  if (!header.startsWith("[")) return false;
  let table: Record<string, unknown>;
  try {
    table = smolParseToml(header);
  } catch {
    // Not a header: a line inside a multi-line value that starts with "[".
    return false;
  }
  const servers = table.mcp_servers;
  return (
    typeof servers === "object" && servers !== null && SERVER_NAME in servers
  );
}

function tomlToString(source: string, entry: ConfigEntry) {
  parseToml(source);
  // Only the owned table and its child tables are replaced; unrelated TOML stays verbatim.
  const sections = source
    .split(/(?=^\s*\[)/m)
    .filter((section) => !isOwnedTomlTable(section));
  const next =
    `${sections.join("").trimEnd()}\n\n${stringifyToml({ mcp_servers: { [SERVER_NAME]: entry } })}`.trimStart();
  const parsed = tomlSchema.parse(parseToml(next));
  // smol-toml emits nested tables last, so compare structurally, not by key order.
  if (!isDeepStrictEqual(parsed.mcp_servers[SERVER_NAME], entry)) {
    throw new Error("Could not safely update the ChainHilt TOML table.");
  }
  return next;
}

function yamlToString(source: string, entry: ConfigEntry, path: string[]) {
  const document = parseDocument(source || "{}", { uniqueKeys: true });
  if (document.errors.length)
    throw new Error("Malformed YAML client configuration");
  document.setIn(path, entry);
  return document.toString();
}

function jsonToString(
  source: string,
  entry: ConfigEntry,
  path: string[],
  client: ClientDefinition,
) {
  // json or json5
  const document = jsonDocument(source, client.format === "json5");
  const errors: ParseError[] = [];
  parseJson(source || "{}", errors, { allowTrailingComma: true });
  const editable = errors.length
    ? JSON.stringify(document, null, 2)
    : source || "{}";
  const next = applyEdits(
    editable,
    modify(editable, path, entry, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );
  jsonDocument(next);
  return next;
}

function clientConfigToString(
  source: string,
  entry: ConfigEntry,
  path: string[],
  client: ClientDefinition,
) {
  let next: string;
  if (client.format === "toml") {
    next = tomlToString(source, entry);
  } else if (client.format === "yaml") {
    next = yamlToString(source, entry, path);
  } else {
    next = jsonToString(source, entry, path, client);
  }
  return next;
}

export function installClient(
  client: ClientDefinition,
  command: ServerCommand,
) {
  const formatter = client.entryFormatter ?? defaultEntryFormatter;
  const existing = readEntry(client);
  const previous =
    existing === undefined ? undefined : formatter.read.parse(existing);
  const userEnv = Object.entries(previous?.env ?? {}).filter(
    ([key]) => !OWNED_ENV.has(key),
  );
  const entry = formatter.write(
    { ...command, env: { ...Object.fromEntries(userEnv), ...command.env } },
    existing === undefined ? {} : entrySchema.parse(existing),
  );
  const source = existsSync(client.config)
    ? readFileSync(client.config, "utf8")
    : "";
  const path = [...client.section, SERVER_NAME];
  const next = clientConfigToString(source, entry, path, client);
  writeConfig(client.config, next);
  if (client.skill) {
    writeConfig(
      client.skill,
      readFileSync(
        new URL("../skills/chainhilt/SKILL.md", import.meta.url),
        "utf8",
      ),
    );
  }
  return {
    client: client.id,
    config: client.config,
    skill: client.skill,
    reload: client.reload,
  };
}
