import { gunzipSync, zipSync, strToU8 } from "fflate";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifest = {
  manifest_version: "0.3",
  name: pkg.name,
  display_name: "ChainHilt Wallet",
  version: pkg.version,
  description: pkg.description,
  long_description: `Local wallet for agents using the [ChainHilt](${pkg.homepage}) API. It authorizes API requests, verifies that each returned action was issued by the API for this wallet's request, then signs and sends it.

- The private key is kept in the OS keychain (a plain \`~/.chainhilt/wallet.key\` file when none is available); it is never sent to the API or shown in chat.
- Wallet setup and funding happen on a private local page, not in the conversation.
- Actions from any other service, or relayed from another request, are refused.`,
  author: { name: pkg.author, url: pkg.homepage },
  homepage: pkg.homepage,
  documentation: `${pkg.homepage}/docs`,
  icon: "icon.png",
  keywords: pkg.keywords,
  license: pkg.license,
  server: {
    type: "node",
    entry_point: "dist/cli.js",
    mcp_config: { command: "node", args: ["${__dirname}/dist/cli.js", "mcp"] },
  },
  tools: [
    { name: "mcp_status", description: "Configuration and wallet address." },
    {
      name: "wallet_setup",
      description: "Open the private local setup and receive page.",
    },
    {
      name: "wallet_balance",
      description:
        "Native or ERC-20 balance for the wallet or another address.",
    },
    { name: "get_chain_info", description: "Supported chains and tokens." },
    {
      name: "authorize_request",
      description:
        "Authorize the exact method, URL and body of an API request.",
    },
    {
      name: "process_action",
      description:
        "Execute the verified actions an authorized request returned.",
    },
  ],
  compatibility: {
    platforms: ["darwin", "win32", "linux"],
    runtimes: { node: ">=22.19.0" },
  },
};
const entries = {
  "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
  "package.json": strToU8(
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      url: pkg.homepage,
      type: "module",
    }),
  ),
  "README.md": new Uint8Array(await readFile(join(root, "README.md"))),
  LICENSE: new Uint8Array(await readFile(join(root, "LICENSE"))),
  NOTICE: new Uint8Array(await readFile(join(root, "NOTICE"))),
  "icon.png": new Uint8Array(await readFile(join(root, "icon.png"))),
};

async function add(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await add(path);
    else
      entries[relative(root, path).replaceAll("\\", "/")] = new Uint8Array(
        await readFile(path),
      );
  }
}
// The npm tarball's only entries are regular files with short paths.
function untar(archive, wanted) {
  const field = (offset, length) =>
    new TextDecoder()
      .decode(archive.subarray(offset, offset + length))
      .replace(/\0.*$/s, "")
      .trim();
  let offset = 0;
  while (offset + 512 <= archive.length && field(offset, 100)) {
    const size = parseInt(field(offset + 124, 12), 8);
    if (field(offset, 100) === wanted)
      return archive.slice(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wanted} is missing from its package`);
}

// The keychain binding is native and loaded from node_modules at runtime, so
// its loader ships with a prebuilt binary for each platform the manifest
// lists, each checked against the lockfile.
const KEYRING_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "win32-arm64-msvc",
  "win32-x64-msvc",
  "linux-arm64-gnu",
  "linux-x64-gnu",
];
async function addKeyring() {
  const directory = join(root, "node_modules", "@napi-rs", "keyring");
  const { version } = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
  const { packages } = parse(
    await readFile(join(root, "pnpm-lock.yaml"), "utf8"),
  );
  for (const file of ["package.json", "index.js", "LICENSE"]) {
    entries[`node_modules/@napi-rs/keyring/${file}`] = new Uint8Array(
      await readFile(join(directory, file)),
    );
  }
  for (const target of KEYRING_TARGETS) {
    const name = `@napi-rs/keyring-${target}`;
    const response = await fetch(
      `https://registry.npmjs.org/${name}/-/keyring-${target}-${version}.tgz`,
    );
    if (!response.ok) {
      throw new Error(
        `Could not download ${name}@${version}: ${response.status}`,
      );
    }
    const tarball = new Uint8Array(await response.arrayBuffer());
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    if (integrity !== packages[`${name}@${version}`]?.resolution?.integrity) {
      throw new Error(`${name}@${version} does not match pnpm-lock.yaml`);
    }
    const binary = `keyring.${target}.node`;
    entries[`node_modules/@napi-rs/keyring/${binary}`] = untar(
      gunzipSync(tarball),
      `package/${binary}`,
    );
  }
}

await add(join(root, "dist"));
await add(join(root, "assets"));
await add(join(root, "skills"));
await addKeyring();
await mkdir(join(root, "artifacts"), { recursive: true });
const destination = join(root, "artifacts", `chainhilt-${pkg.version}.mcpb`);
await writeFile(destination, zipSync(entries));
console.log(destination);
