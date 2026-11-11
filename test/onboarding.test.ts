import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { get as httpGet } from "node:http";
import { z } from "zod";
import { parse as parseToml } from "smol-toml";
import { spawn, spawnSync } from "node:child_process";
import { loadConfig, requireWallet } from "../src/config.js";
import { saveWallet, readWallet } from "../src/wallet.js";
import {
  clientDefinitions,
  installClient,
  readConfig,
  serverCommand,
  detectClients,
  manualInstructions,
} from "../src/install.js";
import { startSetupSession } from "../src/setup.js";
import { probeServer } from "../src/cli/doctor.js";
import { unconfigured } from "../src/cli/init.js";
import { runWalletSetup } from "../src/cli/wallet.js";

const privateKey = `0x${"0".repeat(63)}1`;

function isolated(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "chainhilt onboarding "));
  const keys = [
    "CHAINHILT_HOME",
    "WALLET_PRIVATE_KEY",
    "ACTIVE_CHAIN_ID",
    "API_BASE_URL",
    "NODE_ENV",
    "CHAINHILT_KEY_STORAGE",
  ];
  const original = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  for (const key of keys) delete process.env[key];
  process.env.CHAINHILT_HOME = home;
  // Keeps the developer's OS keychain out of these tests; keyStorage.test.ts covers it.
  process.env.CHAINHILT_KEY_STORAGE = "file";
  t.after(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test("empty configuration defaults to production without creating a wallet, then loads a saved key", async (t) => {
  const home = isolated(t);
  const config = loadConfig();
  assert.equal(config.activeChainConfig.chainId, 8453);
  assert.equal(config.apiBaseUrl, "https://chainhilt.ai/api/v1");
  assert.equal(config.account, undefined);
  assert.deepEqual(readdirSync(home), []);
  await assert.rejects(requireWallet(config), /wallet_not_configured/);
  const saved = await saveWallet(privateKey);
  assert.equal(saved.keyStorage, "file");
  assert.equal((await requireWallet(config)).account.address, saved.address);
  assert.deepEqual(readWallet(), {
    address: saved.address,
    keyStorage: "file",
  });
  if (process.platform !== "win32")
    assert.equal(statSync(join(home, "wallet.key")).mode & 0o777, 0o600);
  await assert.rejects(saveWallet(), /already configured/);
  process.env.WALLET_PRIVATE_KEY = `0x${"0".repeat(63)}2`;
  assert.notEqual(readWallet()?.address, saved.address);
  assert.equal(readWallet()?.keyStorage, "env");
  // A live server never switches its signing identity; it refuses until restart.
  await assert.rejects(requireWallet(config), /wallet_changed/);
});

test("a restored wallet.key with wide permissions is restricted on load", (t) => {
  if (process.platform === "win32") return;
  const home = isolated(t);
  const error = t.mock.method(console, "error", () => {});
  const file = join(home, "wallet.key");
  // As restored from a backup: world-readable key in a world-readable folder.
  writeFileSync(file, `${privateKey}\n`);
  chmodSync(file, 0o644);
  chmodSync(home, 0o755);
  assert.ok(readWallet());
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(error.mock.callCount(), 2);

  // Already owner-only: left alone, and nothing is logged.
  assert.ok(readWallet());
  assert.equal(error.mock.callCount(), 2);
});

test("concurrent setup processes publish exactly one complete wallet", async (t) => {
  const home = isolated(t);
  const walletModule = new URL("../src/wallet.ts", import.meta.url).href;
  const script = `import { saveWallet } from ${JSON.stringify(walletModule)}; try { await saveWallet(); } catch { process.exitCode = 1; }`;
  const run = () =>
    new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          env: {
            ...process.env,
            CHAINHILT_HOME: home,
            WALLET_PRIVATE_KEY: "",
          },
          stdio: "ignore",
        },
      );
      child.once("error", reject);
      child.once("exit", resolve);
    });
  const results = await Promise.all([run(), run(), run()]);
  assert.equal(results.filter((code) => code === 0).length, 1);
  assert.match(
    readFileSync(join(home, "wallet.key"), "utf8").trim(),
    /^0x[0-9a-f]{64}$/,
  );
  assert.ok(readWallet());
  assert.deepEqual(readdirSync(home), ["wallet.key"]);
});

test("claude code is detected by its config directory, not the shared home", (t) => {
  const home = isolated(t);
  const detected = (env: NodeJS.ProcessEnv) =>
    detectClients(clientDefinitions(home, "linux", env)).map(
      (client) => client.id,
    );
  // The home directory always exists, so it alone must not count.
  assert.deepEqual(detected({}), []);
  mkdirSync(join(home, ".claude"));
  assert.deepEqual(detected({}), ["claude-code"]);
  const configDir = join(home, "custom-claude");
  mkdirSync(configDir);
  assert.deepEqual(detected({ CLAUDE_CONFIG_DIR: configDir }), ["claude-code"]);
});

test("every client registration preserves other settings and is repeatable", (t) => {
  const home = isolated(t);
  assert.deepEqual(detectClients(clientDefinitions(home, "linux", {})), []);
  for (const client of clientDefinitions(home, "linux", {})) {
    const command = {
      command: "node",
      args: ["/a path with spaces/cli.js", "mcp"],
      env: { CHAINHILT_HOME: home },
    };
    installClient(client, command);
    assert.deepEqual(readConfig(client), command);
    const before = readFileSync(client.config, "utf8");
    installClient(client, command);
    assert.equal(readFileSync(client.config, "utf8"), before);
    if (client.skill) {
      assert.match(readFileSync(client.skill, "utf8"), /authorize_request/);
    }
  }
  const codex = clientDefinitions(home, "linux", {})[2];
  writeFileSync(
    codex.config,
    '# keep this comment\nmodel = "test"\n[features]\nexample = true\n[mcp_servers.other]\ncommand = "other"\n',
  );
  installClient(codex, {
    command: "node",
    args: ["cli.js", "mcp"],
    env: { EXISTING: "retained" },
  });
  installClient(codex, {
    command: "npx",
    args: ["-y", "chainhilt@0.0.1", "mcp"],
  });
  const next = readFileSync(codex.config, "utf8");
  assert.match(next, /# keep this comment/);
  assert.match(next, /\[features\]\nexample = true/);
  assert.match(next, /\[mcp_servers.other\]/);
  assert.equal(readConfig(codex)?.env?.EXISTING, "retained");
  // Backups and temporary files only survive a failed write.
  assert.deepEqual(
    readdirSync(join(home, ".codex")).filter((name) =>
      name.includes(".chainhilt-"),
    ),
    [],
  );
  if (process.platform !== "win32") {
    // Dotfile-managed configs are symlinks; the link and the target's mode must survive.
    const dotfile = join(home, "dotfiles-config.toml");
    writeFileSync(dotfile, 'model = "linked"\n', { mode: 0o644 });
    chmodSync(dotfile, 0o644);
    rmSync(codex.config);
    symlinkSync(dotfile, codex.config);
    installClient(codex, { command: "node", args: ["cli.js", "mcp"] });
    assert.ok(lstatSync(codex.config).isSymbolicLink());
    assert.match(readFileSync(dotfile, "utf8"), /mcp_servers/);
    assert.equal(statSync(dotfile).mode & 0o777, 0o644);
    assert.deepEqual(
      readdirSync(home).filter((name) => name.includes(".chainhilt-")),
      [],
    );
  }
  const openclaw = clientDefinitions(home, "linux", {})[4];
  writeFileSync(
    openclaw.config,
    '{ gateway: { port: 18789 }, mcp: { servers: { other: { command: "other", args: [] } } } }',
  );
  installClient(openclaw, { command: "node", args: ["cli.js", "mcp"] });
  assert.equal(
    JSON.parse(readFileSync(openclaw.config, "utf8")).gateway.port,
    18789,
  );
  assert.equal(
    JSON.parse(readFileSync(openclaw.config, "utf8")).mcp.servers.other.command,
    "other",
  );
});

test("clients with their own server entry shape get it written and read back", (t) => {
  const home = isolated(t);
  const clients = clientDefinitions(home, "linux", {});
  const byId = (id: string) => {
    const client = clients.find((entry) => entry.id === id);
    assert.ok(client);
    return client;
  };
  const command = {
    command: "npx",
    args: ["-y", "chainhilt@0.0.1", "mcp"],
    env: { CHAINHILT_HOME: home },
  };
  const vscode = byId("vscode");
  installClient(vscode, command);
  assert.deepEqual(
    JSON.parse(readFileSync(vscode.config, "utf8")).servers["chainhilt-wallet"],
    { type: "stdio", ...command },
  );
  const opencode = byId("opencode");
  installClient(opencode, command);
  assert.deepEqual(
    JSON.parse(readFileSync(opencode.config, "utf8")).mcp["chainhilt-wallet"],
    {
      type: "local",
      command: ["npx", "-y", "chainhilt@0.0.1", "mcp"],
      environment: { CHAINHILT_HOME: home },
      enabled: true,
    },
  );
  const goose = byId("goose");
  mkdirSync(dirname(goose.config), { recursive: true });
  writeFileSync(goose.config, "GOOSE_PROVIDER: openai\n");
  installClient(goose, command);
  const gooseConfig = readFileSync(goose.config, "utf8");
  assert.match(gooseConfig, /GOOSE_PROVIDER: openai/);
  assert.match(gooseConfig, /cmd: npx/);
  assert.match(gooseConfig, /type: stdio/);
  assert.deepEqual(readConfig(goose), command);
  // Zed keeps servers under context_servers in its main settings file.
  const zed = byId("zed");
  mkdirSync(dirname(zed.config), { recursive: true });
  writeFileSync(zed.config, '// keep\n{ "theme": "One Dark" }');
  installClient(zed, command);
  assert.match(readFileSync(zed.config, "utf8"), /\/\/ keep/);
  assert.deepEqual(
    JSON.parse(readFileSync(zed.config, "utf8").replace("// keep\n", ""))
      .context_servers["chainhilt-wallet"],
    command,
  );
  assert.equal(
    clientDefinitions(home, "win32", {}).find((client) => client.id === "goose")
      ?.config,
    join(home, "AppData", "Roaming", "Block", "goose", "config", "config.yaml"),
  );
  assert.equal(
    clientDefinitions(home, "darwin", {}).find(
      (client) => client.id === "vscode",
    )?.config,
    join(home, "Library", "Application Support", "Code", "User", "mcp.json"),
  );
  assert.equal(
    clientDefinitions(home, "linux", { CLINE_DIR: join(home, "c") }).find(
      (client) => client.id === "cline",
    )?.config,
    join(home, "c", "data", "settings", "cline_mcp_settings.json"),
  );
  const manual = manualInstructions(command);
  assert.deepEqual(
    JSON.parse(manual.config).mcpServers["chainhilt-wallet"],
    command,
  );
});

test("reinstalling replaces only owned fields and keeps user settings", (t) => {
  const home = isolated(t);
  const clients = clientDefinitions(home, "linux", {});
  const byId = (id: string) => {
    const client = clients.find((entry) => entry.id === id);
    assert.ok(client);
    return client;
  };
  const upgrade = {
    command: "npx",
    args: ["-y", "chainhilt@0.0.4", "mcp"],
    env: { CHAINHILT_HOME: home },
  };
  const codex = byId("codex");
  mkdirSync(dirname(codex.config), { recursive: true });
  writeFileSync(
    codex.config,
    [
      "[mcp_servers.chainhilt-wallet]",
      'command = "node"',
      'args = ["cli.js", "mcp"]',
      'disabled_tools = ["process_action"]',
      "startup_timeout_sec = 30",
      "[mcp_servers.chainhilt-wallet.env]",
      'API_BASE_URL = "http://localhost:3000/api/v1"',
      'ACTIVE_CHAIN_ID = "84532"',
      'CHAINHILT_KEY_STORAGE = "file"',
      'RPC_TOKEN = "user"',
      "",
    ].join("\n"),
  );
  installClient(codex, upgrade);
  const table = z
    .object({
      mcp_servers: z.record(z.string(), z.record(z.string(), z.json())),
    })
    .parse(parseToml(readFileSync(codex.config, "utf8"))).mcp_servers[
    "chainhilt-wallet"
  ];
  assert.deepEqual(table, {
    command: "npx",
    args: ["-y", "chainhilt@0.0.4", "mcp"],
    disabled_tools: ["process_action"],
    startup_timeout_sec: 30,
    // A stale local API_BASE_URL, chain and plain-file preference must not outlive a later init.
    env: { RPC_TOKEN: "user", CHAINHILT_HOME: home },
  });

  const cursor = byId("cursor");
  mkdirSync(dirname(cursor.config), { recursive: true });
  writeFileSync(
    cursor.config,
    JSON.stringify({
      mcpServers: {
        "chainhilt-wallet": {
          command: "node",
          args: ["cli.js", "mcp"],
          disabled: true,
          enabledTools: ["mcp_status"],
        },
      },
    }),
  );
  installClient(cursor, upgrade);
  assert.deepEqual(
    JSON.parse(readFileSync(cursor.config, "utf8")).mcpServers[
      "chainhilt-wallet"
    ],
    { ...upgrade, disabled: true, enabledTools: ["mcp_status"] },
  );

  const opencode = byId("opencode");
  mkdirSync(dirname(opencode.config), { recursive: true });
  writeFileSync(
    opencode.config,
    JSON.stringify({
      mcp: {
        "chainhilt-wallet": {
          type: "local",
          command: ["node", "cli.js", "mcp"],
          enabled: false,
        },
      },
    }),
  );
  installClient(opencode, upgrade);
  assert.equal(
    JSON.parse(readFileSync(opencode.config, "utf8")).mcp["chainhilt-wallet"]
      .enabled,
    false,
  );

  const goose = byId("goose");
  mkdirSync(dirname(goose.config), { recursive: true });
  writeFileSync(
    goose.config,
    "extensions:\n  chainhilt-wallet:\n    cmd: node\n    args: [cli.js, mcp]\n    enabled: false\n    timeout: 60\n",
  );
  installClient(goose, upgrade);
  const gooseConfig = readFileSync(goose.config, "utf8");
  assert.match(gooseConfig, /enabled: false/);
  assert.match(gooseConfig, /timeout: 60/);
  assert.deepEqual(readConfig(goose), upgrade);
});

test("malformed client files are not overwritten and platform paths use overrides", (t) => {
  const home = isolated(t);
  const clients = clientDefinitions(home, "win32", {
    CODEX_HOME: join(home, "custom codex"),
    HERMES_HOME: join(home, "hermes"),
    PI_CODING_AGENT_DIR: join(home, "pi"),
    OPENCLAW_CONFIG_PATH: join(home, "claw.json"),
  });
  const claude = clients[0];
  writeFileSync(claude.config, "{ invalid json");
  assert.throws(
    () => installClient(claude, serverCommand()),
    /Malformed client configuration/,
  );
  assert.equal(readFileSync(claude.config, "utf8"), "{ invalid json");
  assert.equal(clients[2].config, join(home, "custom codex", "config.toml"));
  assert.equal(
    clients[1].config,
    join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
  );
  assert.equal(
    clientDefinitions(home, "win32", {})[5].config,
    join(home, "AppData", "Local", "hermes", "config.yaml"),
  );
  assert.equal(
    clientDefinitions(home, "linux", {})[5].config,
    join(home, ".hermes", "config.yaml"),
  );
  assert.equal(serverCommand(false, "win32").command, "cmd.exe");
  assert.equal(serverCommand(false, "linux").command, "npx");
  assert.ok(serverCommand(true).args[0].endsWith("cli.js"));
  // A key file kept on purpose stays out of the keychain when the registered server starts.
  assert.equal(serverCommand().env?.CHAINHILT_KEY_STORAGE, "file");
  delete process.env.CHAINHILT_KEY_STORAGE;
  assert.equal(serverCommand().env?.CHAINHILT_KEY_STORAGE, undefined);
});

test("terminal setup refuses a redirected stderr, where a new key would land in a log", async (t) => {
  const home = isolated(t);
  // As with `chainhilt wallet setup --terminal 2> setup.log` typed in a terminal.
  const stdinTTY = process.stdin.isTTY;
  const stderrTTY = process.stderr.isTTY;
  t.after(() => {
    process.stdin.isTTY = stdinTTY;
    process.stderr.isTTY = stderrTTY;
  });
  process.stdin.isTTY = true;
  process.stderr.isTTY = false;
  await assert.rejects(
    runWalletSetup({ terminal: true }),
    /interactive terminal/,
  );
  assert.deepEqual(readdirSync(home), []);
});

test("owned TOML tables are found however their headers are spelled", (t) => {
  const home = isolated(t);
  const codex = clientDefinitions(home, "linux", {})[2];
  mkdirSync(dirname(codex.config), { recursive: true });
  for (const [table, envTable] of [
    [
      "[ mcp_servers.chainhilt-wallet ]",
      "[ mcp_servers.chainhilt-wallet.env ]",
    ],
    [
      '[mcp_servers . "chainhilt-wallet"]',
      "[mcp_servers.'chainhilt-wallet'.env]",
    ],
    [
      '[mcp_servers."chainhilt\\u002Dwallet"] # escaped',
      "[mcp_servers.chainhilt-wallet.env]",
    ],
  ]) {
    writeFileSync(
      codex.config,
      [
        "model = 'kept'",
        // A multi-line value with a line starting with "[" is not a header.
        "matrix = [",
        "[1, 2],",
        "]",
        table,
        'command = "node"',
        'args = ["cli.js", "mcp"]',
        "startup_timeout_sec = 30",
        envTable,
        'RPC_TOKEN = "user"',
        "[mcp_servers.other]",
        'command = "other"',
        "",
      ].join("\r\n"),
    );
    installClient(codex, serverCommand());
    const next = z
      .object({
        model: z.string(),
        matrix: z.array(z.array(z.number())),
        mcp_servers: z.record(z.string(), z.record(z.string(), z.json())),
      })
      .parse(parseToml(readFileSync(codex.config, "utf8")));
    assert.equal(next.model, "kept", table);
    assert.deepEqual(next.matrix, [[1, 2]], table);
    assert.equal(next.mcp_servers.other.command, "other", table);
    assert.equal(next.mcp_servers["chainhilt-wallet"].startup_timeout_sec, 30);
    assert.deepEqual(readConfig(codex)?.env?.RPC_TOKEN, "user", table);
  }
});

test("config errors never quote a wallet key kept in the client entry", (t) => {
  const home = isolated(t);
  const clients = clientDefinitions(home, "linux", {});
  const byId = (id: string) => {
    const client = clients.find((entry) => entry.id === id);
    assert.ok(client);
    return client;
  };
  // Distinctive, so a partial quote in an error is still caught.
  const secret = `0x${"5ec7e7".repeat(10)}abcd`;
  // doctor prints these errors, so each parser and zod are checked for echoing nearby values.
  const cases = [
    {
      name: "toml syntax",
      client: byId("codex"),
      source: `[mcp_servers.chainhilt-wallet]\ncommand = "node"\nargs = []\n[mcp_servers.chainhilt-wallet.env]\nWALLET_PRIVATE_KEY = "${secret}"\nbroken =\n`,
    },
    {
      name: "toml schema",
      client: byId("codex"),
      source: `[mcp_servers.chainhilt-wallet]\ncommand = "node"\nargs = "${secret}"\n[mcp_servers.chainhilt-wallet.env]\nWALLET_PRIVATE_KEY = "${secret}"\n`,
    },
    {
      name: "json syntax",
      client: byId("cursor"),
      source: `{ "mcpServers": { "chainhilt-wallet": { "command": "node", "args": [], "env": { "WALLET_PRIVATE_KEY": "${secret}" broken } } } }`,
    },
    {
      name: "json schema",
      client: byId("cursor"),
      source: JSON.stringify({
        mcpServers: {
          "chainhilt-wallet": {
            command: "node",
            args: secret,
            env: { WALLET_PRIVATE_KEY: secret },
          },
        },
      }),
    },
    {
      name: "json5 syntax",
      client: byId("openclaw"),
      source: `{ mcp: { servers: { "chainhilt-wallet": { command: "node", args: [], env: { WALLET_PRIVATE_KEY: "${secret}" broken } } } } }`,
    },
    {
      name: "json5 schema",
      client: byId("openclaw"),
      source: `{ mcp: { servers: { "chainhilt-wallet": { command: "node", args: "${secret}", env: { WALLET_PRIVATE_KEY: "${secret}" } } } } }`,
    },
    {
      name: "yaml syntax",
      client: byId("hermes"),
      source: `mcp_servers:\n  chainhilt-wallet:\n    command: node\n    args: []\n    env:\n      WALLET_PRIVATE_KEY: "${secret}"\n      broken: [\n`,
    },
    {
      name: "yaml schema",
      client: byId("hermes"),
      source: `mcp_servers:\n  chainhilt-wallet:\n    command: node\n    args: "${secret}"\n    env:\n      WALLET_PRIVATE_KEY: "${secret}"\n`,
    },
  ];
  for (const { name, client, source } of cases) {
    mkdirSync(dirname(client.config), { recursive: true });
    writeFileSync(client.config, source);
    const withoutSecret = (error: Error) => {
      assert.ok(!error.message.includes(secret.slice(2, 14)), name);
      return true;
    };
    assert.throws(() => readConfig(client), withoutSecret, name);
    assert.throws(
      () => installClient(client, serverCommand()),
      withoutSecret,
      name,
    );
    assert.equal(readFileSync(client.config, "utf8"), source, name);
    rmSync(client.config);
  }
});

test("wallet setup reports why a --chain-id is rejected", (t) => {
  const home = isolated(t);
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  for (const chainId of ["abc", "999999"]) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        cli,
        "wallet",
        "setup",
        "--chain-id",
        chainId,
        "--json",
      ],
      { env: { ...process.env, CHAINHILT_HOME: home }, encoding: "utf8" },
    );
    assert.equal(result.status, 1, chainId);
    assert.match(
      z.object({ error: z.string() }).parse(JSON.parse(result.stdout)).error,
      new RegExp(
        `^Unsupported --chain-id ${chainId}\\. Supported: .*\\b8453\\b`,
      ),
    );
  }
});

test("doctor probes with the registration env, not the shell's", async (t) => {
  isolated(t);
  // MCP clients never pass shell exports through, so doctor must not see them either.
  process.env.WALLET_PRIVATE_KEY = privateKey;
  process.env.API_BASE_URL = "http://shell.invalid";
  const status = await probeServer({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      fileURLToPath(new URL("./fixtures/envProbeServer.ts", import.meta.url)),
    ],
    env: { API_BASE_URL: "http://registration.invalid" },
  });
  assert.equal(status.connected, true);
  assert.equal(status.configured, false);
  assert.equal(status.apiBaseUrl, "http://registration.invalid");
});

test("init offers wallet setup only when the registered server reports no wallet", async (t) => {
  const home = isolated(t);
  const server = {
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      "mcp",
    ],
  };
  // An empty key keeps this checkout's package .env out; an installed package has none.
  const bare = await probeServer({
    ...server,
    env: { CHAINHILT_HOME: home, WALLET_PRIVATE_KEY: "" },
  });
  assert.equal(unconfigured(bare), true);
  // A key kept in the client's config is the server's wallet, so setup must not offer another.
  const keyed = await probeServer({
    ...server,
    env: { CHAINHILT_HOME: home, WALLET_PRIVATE_KEY: privateKey },
  });
  assert.equal(
    keyed.walletAddress,
    "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
  );
  assert.equal(unconfigured(keyed), false);
  // A server that did not start says nothing about its wallet.
  assert.equal(
    unconfigured({ connected: false, error: "spawn npx ENOENT", nextStep: "" }),
    false,
  );
});

test("private setup rejects wrong origin/token, imports once, and returns public deposit details", async (t) => {
  const home = isolated(t);
  const session = await startSetupSession();
  t.after(() => session.close());
  const url = new URL(session.url);
  const response = await fetch(url);
  const page = await response.text();
  const csp = response.headers.get("content-security-policy") ?? "";
  // Inlined assets are allowed only through the per-response nonce, never unsafe-inline.
  const nonce = /script-src 'nonce-([^']+)';/.exec(csp)?.[1];
  assert.ok(nonce);
  assert.ok(csp.includes(`style-src 'nonce-${nonce}';`));
  assert.ok(!csp.includes("unsafe-inline"));
  assert.ok(page.includes(`<style nonce="${nonce}">`));
  assert.ok(page.includes("color-scheme: dark"));
  assert.ok(page.includes(`<script type="module" nonce="${nonce}">`));
  assert.ok(page.includes('await api("/status")'));
  assert.ok(!page.includes('src="/app.js"'));
  assert.ok(!page.includes('href="/style.css"'));
  const headers = {
    authorization: `Bearer ${url.hash.slice(1)}`,
    origin: url.origin,
    "content-type": "application/json",
  };
  assert.equal((await fetch(`${url.origin}/status`)).status, 401);
  assert.equal(
    (
      await fetch(`${url.origin}/status`, {
        headers: { ...headers, origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  // The same server opened as localhost works, but only on the session's port.
  const localhost = `http://localhost:${url.port}`;
  assert.equal((await fetch(`${localhost}/`)).status, 200);
  assert.equal(
    (
      await fetch(`${localhost}/status`, {
        headers: { ...headers, origin: localhost },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${url.origin}/status`, {
        headers: {
          ...headers,
          origin: `http://localhost:${Number(url.port) + 1}`,
        },
      })
    ).status,
    403,
  );
  const forwardedStatus = await new Promise<number | undefined>(
    (resolve, reject) =>
      httpGet(
        `${url.origin}/`,
        { headers: { host: `localhost:${Number(url.port) + 1}` } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      ).on("error", reject),
  );
  assert.equal(forwardedStatus, 403);
  assert.equal(
    (
      await fetch(`${url.origin}/wallet`, {
        method: "POST",
        headers: {
          authorization: headers.authorization,
          "content-type": "application/json",
        },
        body: '{"mode":"create"}',
      })
    ).status,
    403,
  );
  const invalid = await fetch(`${url.origin}/wallet`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mode: "import", privateKey: "invalid" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(existsSync(join(home, "wallet.key")), false);
  const imported = await fetch(`${url.origin}/wallet`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mode: "import", privateKey }),
  });
  assert.equal(imported.status, 201);
  const importedWallet = z
    .record(z.string(), z.json())
    .parse(await imported.json());
  assert.equal("privateKey" in importedWallet, false);
  assert.equal(importedWallet.keyStorage, "file");
  assert.match(String(importedWallet.warning), /plain text/);
  const duplicate = await fetch(`${url.origin}/wallet`, {
    method: "POST",
    headers,
    body: '{"mode":"create"}',
  });
  assert.equal(duplicate.status, 409);
  const deposit = await fetch(`${url.origin}/deposit?chainId=8453&asset=USDC`, {
    headers,
  });
  const details = z
    .object({
      address: z.string(),
      chainId: z.number(),
      tokenAddress: z.string(),
      qr: z.string(),
      uri: z.string(),
    })
    .parse(await deposit.json());
  assert.equal(details.address, readWallet()?.address);
  assert.equal(details.chainId, 8453);
  assert.equal(
    details.tokenAddress,
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  );
  assert.match(details.qr, /^data:image\/png;base64,/);
  assert.equal(
    details.uri,
    `ethereum:${details.tokenAddress}@8453/transfer?address=${details.address}`,
  );
  assert.equal(JSON.stringify(details).includes(privateKey), false);
  assert.equal(
    (
      await fetch(`${url.origin}/deposit?chainId=8453&asset=UNKNOWN`, {
        headers,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${url.origin}/onramp`, {
        method: "POST",
        headers,
        body: '{"chainId":8453,"asset":"USDC"}',
      })
    ).status,
    404,
  );
});

test("new wallet backup is only returned during creation, and setup sessions expire", async (t) => {
  isolated(t);
  const session = await startSetupSession({ ttlMs: 1000 });
  t.after(() => session.close());
  const url = new URL(session.url);
  const headers = {
    authorization: `Bearer ${url.hash.slice(1)}`,
    origin: url.origin,
    "content-type": "application/json",
  };
  const created = await fetch(`${url.origin}/wallet`, {
    method: "POST",
    headers,
    body: '{"mode":"create"}',
  });
  const backup = z
    .object({ privateKey: z.string() })
    .parse(await created.json());
  assert.match(backup.privateKey, /^0x[0-9a-f]{64}$/);
  const status = await (
    await fetch(`${url.origin}/status`, { headers })
  ).text();
  assert.equal(status.includes(backup.privateKey), false);
  await session.closed;
  await assert.rejects(fetch(`${url.origin}/status`, { headers }));
});
