import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { probeServer } from "../src/cli/doctor.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "chainhilt artifact "));
try {
  const env = {
    ...process.env,
    CHAINHILT_HOME: join(temporary, "wallet"),
    CODEX_HOME: join(temporary, "codex"),
    WALLET_PRIVATE_KEY: "",
    API_BASE_URL: "https://chainhilt.ai/api/v1",
  };
  const cli = join(root, "dist", "cli.js");
  assert.equal(
    execFileSync(process.execPath, [cli, "--version"], {
      env,
      encoding: "utf8",
    }).trim(),
    pkg.version,
  );
  assert.match(
    execFileSync(process.execPath, [cli, "--help"], { env, encoding: "utf8" }),
    /Commands:/,
  );
  for (const args of [["init"], ["doctor"], ["wallet", "setup"]]) {
    const help = execFileSync(process.execPath, [cli, ...args, "--help"], {
      env,
      encoding: "utf8",
    });
    assert.match(help, new RegExp(`Usage: chainhilt ${args.join(" ")}`));
    assert.match(help, /--json/);
  }
  for (const args of [
    ["unknown"],
    ["wallet", "fund"],
    ["wallet", "export"],
    ["init"],
    ["--json", "init"],
    ["doctor", "--client"],
    ["doctor", "--bogus"],
    ["mcp", "unexpected"],
    ["wallet", "setup", "--terminal"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args, "--json"], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 1);
    assert.equal(typeof JSON.parse(result.stdout).error, "string");
    assert.equal(result.stderr, "");
  }
  const setup = spawn(
    process.execPath,
    [cli, "wallet", "setup", "--chain-id", "8453", "--no-open", "--json"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(setup, "exit");
  const lines = createInterface({ input: setup.stdout });
  try {
    const [line] = await once(lines, "line", {
      signal: AbortSignal.timeout(15_000),
    });
    const session = JSON.parse(line);
    const url = new URL(session.url);
    const response = await fetch(new URL("/status", url), {
      headers: { authorization: `Bearer ${url.hash.slice(1)}` },
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.chainId, 8453);
    assert.equal(status.walletAddress, null);
  } finally {
    setup.kill("SIGTERM");
    await exited;
    lines.close();
  }
  for (const args of [
    [
      "init",
      "--client",
      "codex",
      "--client",
      "codex",
      "--local",
      "--skip-setup",
      "--non-interactive",
      "--json",
    ],
    ["doctor", "--client", "codex", "--json"],
  ]) {
    const result = JSON.parse(
      execFileSync(process.execPath, [cli, ...args], {
        env,
        encoding: "utf8",
        timeout: 30_000,
      }),
    );
    if (args[0] === "init")
      assert.equal(result.installed[0].connection.connected, true);
    else assert.equal(result.checks[0].connected, true);
  }
  assert.equal(
    (await probeServer({ command: process.execPath, args: [cli], env }))
      .configured,
    false,
  );
  const extracted = join(temporary, "bundle");
  const files = unzipSync(
    await readFile(join(root, "artifacts", `chainhilt-${pkg.version}.mcpb`)),
  );
  for (const [name, contents] of Object.entries(files)) {
    assert.ok(!name.startsWith("/") && !name.split("/").includes(".."));
    assert.ok(!name.endsWith(".env") && !name.includes("wallet.key"));
    const path = join(extracted, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  // Loaded from the bundle's own copy, as Claude Desktop installs no dependencies.
  // In a child process, since Windows locks a loaded binary until its process exits.
  const keyring = join(extracted, "node_modules", "@napi-rs", "keyring");
  assert.equal(
    execFileSync(
      process.execPath,
      [
        "-e",
        `console.log(typeof require(${JSON.stringify(keyring)}).AsyncEntry)`,
      ],
      { encoding: "utf8" },
    ).trim(),
    "function",
  );
  const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString());
  assert.equal(manifest.manifest_version, "0.3");
  assert.ok(files["LICENSE"] && files["NOTICE"]);
  // Pure ES module packages are the ones license collection misses when webpack concatenates them.
  const notices = Buffer.from(
    files["dist/THIRD-PARTY-LICENSES.txt"],
  ).toString();
  for (const name of [
    "zod",
    "hono",
    "commander",
    "yaml",
    "smol-toml",
    "viem",
    "@modelcontextprotocol/server",
  ]) {
    assert.match(notices, new RegExp(`^${name}$`, "m"), name);
  }
  const command = {
    command: process.execPath,
    args: [join(extracted, manifest.server.entry_point)],
    env,
  };
  const status = await probeServer(command);
  assert.equal(status.configured, false);
  const client = new Client({ name: "bundle-smoke", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({ ...command, stderr: "ignore" }),
    );
    const result = await client.callTool({
      name: "wallet_setup",
      arguments: {},
    });
    assert.ok(!result.isError);
    const session = JSON.parse(
      result.content.find((entry) => entry.type === "text").text,
    );
    const response = await fetch(session.url);
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.match(page, /Your agent's signing wallet/i);
    // Self-contained, so viewers that only load the top-level document still get styles and script.
    assert.match(page, /<style nonce="[^"]+">/);
    assert.match(page, /<script type="module" nonce="[^"]+">/);
    assert.match(page, /src="data:image\/svg\+xml;base64,/);
    assert.ok(!page.includes('src="/app.js"'));
    assert.ok(!page.includes('href="/style.css"'));
    assert.ok(!page.includes('src="/logo.svg"'));
  } finally {
    await client.close();
  }
  await assert.rejects(access(join(temporary, "wallet", "wallet.key")));
  await assert.rejects(access(join(temporary, "wallet", "wallet.json")));
  console.log(
    "Compiled CLI init/doctor and standalone MCPB setup assets passed. No wallet was created.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
