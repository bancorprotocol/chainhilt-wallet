import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { AsyncEntry } from "@napi-rs/keyring";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { Address } from "viem";
import { z } from "zod";
import {
  keyStorageWarning,
  migrateKeyFile,
  readPrivateKey,
  readWallet,
  saveWallet,
} from "../src/wallet.js";
import type { Keychain } from "../src/keychain.js";
import { fakeKeychain } from "./fixtures/fakeKeyring.js";
import {
  loadConfig,
  requireWallet,
  requireWalletAddress,
  getWalletChangeWarning,
} from "../src/config.js";
import { createServer } from "../src/index.js";

const privateKey = `0x${"0".repeat(63)}1`;
const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

function isolated(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "chainhilt key storage "));
  const keys = [
    "CHAINHILT_HOME",
    "WALLET_PRIVATE_KEY",
    "CHAINHILT_KEY_STORAGE",
  ];
  const original = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  for (const key of keys) delete process.env[key];
  process.env.CHAINHILT_HOME = home;
  t.after(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

// Replaces the native keyring with an in-memory one keyed by wallet address.
// Reassign `keychain.read` or `keychain.write` to change how it behaves.
function mockKeychain(t: TestContext) {
  const items = new Map<Address, string>();
  const keychain: Keychain = {
    read: async (item) => items.get(item),
    write: async (item, key) => {
      items.set(item, key);
    },
  };
  fakeKeychain.current = keychain;
  t.after(() => {
    delete fakeKeychain.current;
  });
  return { items, keychain };
}

const unavailable = async () => {
  throw new Error("No Secret Service");
};

// Runs `body` after `@napi-rs/keyring` is replaced by an in-memory one whose
// `write` is the given expression, in a process of its own.
function keychainProcessScript(write: string, body: string) {
  const fakeKeyringModule = new URL("fixtures/fakeKeyring.ts", import.meta.url)
    .href;
  const walletModule = new URL("../src/wallet.ts", import.meta.url).href;
  return `const { fakeKeychain } = await import(${JSON.stringify(fakeKeyringModule)});
const items = new Map();
fakeKeychain.current = { read: async (address) => items.get(address), write: ${write} };
const { saveWallet } = await import(${JSON.stringify(walletModule)});
${body}`;
}

// A setup in its own process whose keychain write waits for a line on stdin,
// so a test can act while the key is being stored.
function setupInProgress(t: TestContext, home: string) {
  const script = keychainProcessScript(
    `(address, key) => new Promise((resolve) => {
  process.stdout.write("writing\\n");
  process.stdin.once("data", () => { items.set(address, key); resolve(); });
})`,
    "await saveWallet();",
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      env: { ...process.env, CHAINHILT_HOME: home },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  t.after(() => child.kill("SIGKILL"));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const writing = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("writing")) resolve();
    });
    void exited.then(() =>
      reject(new Error("The setup exited before storing the key.")),
    );
  });
  return { child, writing, exited };
}

test("a new key goes to the OS keychain, and wallet.json holds only the address", async (t) => {
  const home = isolated(t);
  const { items } = mockKeychain(t);
  const saved = await saveWallet(privateKey);
  assert.deepEqual(saved, { address, privateKey, keyStorage: "keychain" });
  assert.deepEqual(readdirSync(home), ["wallet.json"]);
  assert.deepEqual(
    JSON.parse(readFileSync(join(home, "wallet.json"), "utf8")),
    {
      address,
      storage: "keychain",
    },
  );
  assert.deepEqual([...items], [[address, privateKey]]);
  assert.deepEqual(readWallet(), { address, keyStorage: "keychain" });
  assert.equal(keyStorageWarning("keychain"), undefined);
  assert.equal(await readPrivateKey(), privateKey);
  await assert.rejects(saveWallet(), /already configured/);
  assert.equal(items.size, 1);
});

test("a keychain wallet whose item is missing or holds another key is refused", async (t) => {
  isolated(t);
  const { items } = mockKeychain(t);
  await saveWallet(privateKey);
  items.clear();
  await assert.rejects(readPrivateKey(), /no key for wallet/);
  items.set(address, `0x${"0".repeat(63)}2`);
  await assert.rejects(readPrivateKey(), /another wallet's key/);
});

test("the wallet address is available without reading the keychain", async (t) => {
  const home = isolated(t);
  const { items } = mockKeychain(t);
  await saveWallet(privateKey);
  // As when keychain access is denied: the key cannot be read, the address still can.
  items.clear();
  await assert.rejects(readPrivateKey(), /no key for wallet/);
  assert.equal(requireWalletAddress(loadConfig()), address);
  rmSync(join(home, "wallet.json"));
  assert.throws(
    () => requireWalletAddress(loadConfig()),
    /wallet_not_configured/,
  );
});

test("without a working keychain the key falls back to a plain file, with a warning", async (t) => {
  const home = isolated(t);
  const { keychain } = mockKeychain(t);
  keychain.write = unavailable;
  const saved = await saveWallet(privateKey);
  assert.equal(saved.keyStorage, "file");
  assert.deepEqual(readdirSync(home), ["wallet.key"]);
  assert.deepEqual(readWallet(), { address, keyStorage: "file" });
  assert.match(keyStorageWarning("file") ?? "", /plain text.*No OS keychain/);
  rmSync(join(home, "wallet.key"));
  // A keychain that loses the key fails the read-back.
  keychain.write = async () => {};
  assert.equal((await saveWallet(privateKey)).keyStorage, "file");
  assert.deepEqual(readdirSync(home), ["wallet.key"]);
});

test("a setup killed while the keychain stores the key leaves no wallet", async (t) => {
  const home = isolated(t);
  const setup = setupInProgress(t, home);
  await setup.writing;
  setup.child.kill("SIGKILL");
  await setup.exited;
  // Nothing shows an address whose key never reached the keychain.
  assert.equal(readWallet(), undefined);
  assert.deepEqual(readdirSync(home), ["setup.lock"]);
  // The next setup takes over the lock the killed one left.
  mockKeychain(t);
  assert.equal((await saveWallet(privateKey)).keyStorage, "keychain");
  assert.deepEqual(readdirSync(home), ["wallet.json"]);
});

test("a setup in the other storage mode is refused while one is running", async (t) => {
  const home = isolated(t);
  const setup = setupInProgress(t, home);
  await setup.writing;
  process.env.CHAINHILT_KEY_STORAGE = "file";
  await assert.rejects(
    saveWallet(privateKey),
    /Another wallet setup is running/,
  );
  setup.child.stdin.end("\n");
  assert.equal(await setup.exited, 0);
  assert.deepEqual(readdirSync(home), ["wallet.json"]);
});

// A setup in its own process that starts when its stdin gets a line, so many
// can start together. Odd ones use the key file, even ones a keychain.
function racingSetup(t: TestContext, home: string, index: number) {
  const script = keychainProcessScript(
    "async (address, key) => { items.set(address, key); }",
    `process.stdout.write("ready\\n");
await new Promise((resolve) => process.stdin.once("data", resolve));
const result = await saveWallet(process.env.RACE_KEY).then(
  (saved) => ({ address: saved.address }),
  (error) => ({ error: error.message }),
);
process.stdout.write(JSON.stringify(result) + "\\n");`,
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      env: {
        ...process.env,
        CHAINHILT_HOME: home,
        RACE_KEY: `0x${(index + 1).toString(16).padStart(64, "0")}`,
        ...(index % 2 ? { CHAINHILT_KEY_STORAGE: "file" } : {}),
      },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  const exited = once(child, "exit");
  const ready = Promise.race([
    new Promise<void>((resolve) =>
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk;
        if (output.startsWith("ready\n")) resolve();
      }),
    ),
    exited,
  ]);
  const result = exited.then((): { address?: Address; error?: string } =>
    JSON.parse(output.trim().split("\n").at(-1) ?? "{}"),
  );
  return { child, ready, result };
}

test("setups racing over a stale lock in both storage modes publish one wallet", async (t) => {
  const home = isolated(t);
  // A lock whose process has exited, as a killed setup leaves it.
  const exited = spawn(process.execPath, ["-e", ""]);
  await once(exited, "exit");
  writeFileSync(join(home, "setup.lock"), `${exited.pid}\n`);
  const setups = Array.from({ length: 6 }, (_, index) =>
    racingSetup(t, home, index),
  );
  await Promise.all(setups.map((setup) => setup.ready));
  for (const setup of setups) setup.child.stdin.end("\n");
  const results = await Promise.all(setups.map((setup) => setup.result));
  const winners = results.filter((result) => result.address);
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.equal(readWallet()?.address, winners[0].address);
  assert.deepEqual(
    readdirSync(home).filter((name) => name.startsWith("setup.lock")),
    [],
  );
});

test("a setup waits while another replaces a stale lock, then respects the new lock", async (t) => {
  const home = isolated(t);
  // Another setup is replacing a stale lock (left empty by a killed setup) under the guard...
  writeFileSync(join(home, "setup.lock.guard"), `${process.pid}\n`);
  writeFileSync(join(home, "setup.lock"), "");
  mockKeychain(t);
  const pending = saveWallet(privateKey);
  // ...and finishes: its live lock replaces the stale one, and the guard is released.
  await new Promise((resolve) => setTimeout(resolve, 120));
  writeFileSync(join(home, "setup.lock"), `${process.pid}\n`);
  rmSync(join(home, "setup.lock.guard"));
  await assert.rejects(pending, /Another wallet setup is running/);
  assert.equal(readWallet(), undefined);
});

test(
  "loading or migrating a wallet restricts its folder and wallet.json to the owner",
  { skip: process.platform === "win32" },
  async (t) => {
    const home = isolated(t);
    t.mock.method(console, "error", () => {});
    mockKeychain(t);
    await saveWallet(privateKey);
    // As when restored from a backup: anyone could replace wallet.json, and with it the receive address.
    chmodSync(home, 0o777);
    chmodSync(join(home, "wallet.json"), 0o666);
    assert.deepEqual(readWallet(), { address, keyStorage: "keychain" });
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, "wallet.json")).mode & 0o777, 0o600);

    rmSync(join(home, "wallet.json"));
    writeFileSync(join(home, "wallet.key"), `${privateKey}\n`, { mode: 0o600 });
    chmodSync(home, 0o777);
    assert.match((await migrateKeyFile()) ?? "", /into the OS keychain/);
    assert.equal(statSync(home).mode & 0o777, 0o700);
  },
);

test("a wallet replaced on disk is refused until restart, not signed for with the loaded key", async (t) => {
  const home = isolated(t);
  // The plain file keeps the developer's keychain out of this test.
  process.env.CHAINHILT_KEY_STORAGE = "file";
  await saveWallet(privateKey);
  const config = loadConfig();
  assert.equal((await requireWallet(config)).account.address, address);
  assert.equal(getWalletChangeWarning(config), undefined);
  rmSync(join(home, "wallet.key"));
  await saveWallet(`0x${"0".repeat(63)}2`);
  assert.match(getWalletChangeWarning(config) ?? "", /Restart the MCP server/);
  await assert.rejects(requireWallet(config), /wallet_changed/);
  assert.throws(() => requireWalletAddress(config), /wallet_changed/);
});

test("a key read still pending when the wallet changes never replaces the identity loaded meanwhile", async (t) => {
  const home = isolated(t);
  const { items, keychain } = mockKeychain(t);
  await saveWallet(privateKey);
  // The first wallet's key comes back only when released, as after a keychain prompt.
  let release = () => {};
  const prompt = new Promise<void>((resolve) => (release = resolve));
  keychain.read = async (item) => {
    if (item === address) await prompt;
    return items.get(item);
  };
  const config = loadConfig();
  const pending = requireWallet(config);
  rmSync(join(home, "wallet.json"));
  await saveWallet(`0x${"0".repeat(63)}2`);
  const other = "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF";
  assert.equal((await requireWallet(config)).account.address, other);
  release();
  assert.equal((await pending).account.address, other);
  assert.equal(config.account?.address, other);
});

test("CHAINHILT_KEY_STORAGE=file keeps a new key out of the keychain", async (t) => {
  const home = isolated(t);
  process.env.CHAINHILT_KEY_STORAGE = "file";
  const { items } = mockKeychain(t);
  assert.equal((await saveWallet(privateKey)).keyStorage, "file");
  assert.equal(items.size, 0);
  assert.deepEqual(readdirSync(home), ["wallet.key"]);
  assert.match(keyStorageWarning("file") ?? "", /Unset CHAINHILT_KEY_STORAGE/);
  assert.equal(await migrateKeyFile(), undefined);
  assert.deepEqual(readdirSync(home), ["wallet.key"]);
});

test("an existing key file moves into the keychain, and stays when the move fails", async (t) => {
  const home = isolated(t);
  writeFileSync(join(home, "wallet.key"), `${privateKey}\n`);
  const { items, keychain } = mockKeychain(t);
  const { write } = keychain;
  keychain.write = unavailable;
  await assert.rejects(migrateKeyFile(), /No Secret Service/);
  assert.deepEqual(readdirSync(home), ["wallet.key"]);
  assert.deepEqual(readWallet(), { address, keyStorage: "file" });
  keychain.write = write;
  assert.match((await migrateKeyFile()) ?? "", /into the OS keychain/);
  assert.deepEqual(readdirSync(home), ["wallet.json"]);
  assert.deepEqual([...items], [[address, privateKey]]);
  assert.deepEqual(readWallet(), { address, keyStorage: "keychain" });
  assert.equal(await readPrivateKey(), privateKey);
  assert.equal(await migrateKeyFile(), undefined);
});

test("the MCP answers while the key file migration is pending, then reports its notice once", async (t) => {
  isolated(t);
  let finish = (_notice: string) => {};
  const migration = new Promise<string>((resolve) => (finish = resolve));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(migration).connect(serverSide);
  const client = new Client({ name: "key-storage-test", version: "1" });
  await client.connect(clientSide);
  t.after(() => client.close());
  const notice = async () => {
    const { content } = await client.callTool({
      name: "mcp_status",
      arguments: {},
    });
    const [{ text }] = z.array(z.object({ text: z.string() })).parse(content);
    return z.object({ notice: z.string().optional() }).parse(JSON.parse(text))
      .notice;
  };
  assert.equal(await notice(), undefined);
  finish("Moved the key.");
  await migration;
  assert.equal(await notice(), "Moved the key.");
  assert.equal(await notice(), undefined);
});

test("a key file is kept when wallet.json names another wallet", async (t) => {
  const home = isolated(t);
  mockKeychain(t);
  await saveWallet(`0x${"0".repeat(63)}2`);
  writeFileSync(join(home, "wallet.key"), `${privateKey}\n`);
  await assert.rejects(migrateKeyFile(), /names another wallet/);
  assert.deepEqual(readdirSync(home).sort(), ["wallet.json", "wallet.key"]);
});

test("WALLET_PRIVATE_KEY is reported as env storage with a warning", (t) => {
  isolated(t);
  process.env.WALLET_PRIVATE_KEY = privateKey;
  assert.deepEqual(readWallet(), { address, keyStorage: "env" });
  assert.match(keyStorageWarning("env") ?? "", /development and CI/);
});

// Writes to the real OS keychain, so it runs only when asked; CI sets it on
// each platform (Linux needs an unlocked Secret Service).
test(
  "the OS keychain stores and returns a new wallet's key",
  { skip: !process.env.CHAINHILT_KEYCHAIN_TEST },
  async (t) => {
    isolated(t);
    const saved = await saveWallet();
    t.after(() =>
      new AsyncEntry("chainhilt", saved.address, {
        linux: { store: "secret-service" },
      }).deletePassword(),
    );
    assert.equal(saved.keyStorage, "keychain");
    assert.equal(await readPrivateKey(), saved.privateKey);
  },
);
