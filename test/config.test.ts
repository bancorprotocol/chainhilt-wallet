import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { loadConfig } from "../src/config.js";
import { restrictToOwner } from "../src/wallet.js";

function preserveConfigEnv(t: TestContext) {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  const activeChainId = process.env.ACTIVE_CHAIN_ID;

  t.after(() => {
    if (privateKey === undefined) delete process.env.WALLET_PRIVATE_KEY;
    else process.env.WALLET_PRIVATE_KEY = privateKey;

    if (activeChainId === undefined) delete process.env.ACTIVE_CHAIN_ID;
    else process.env.ACTIVE_CHAIN_ID = activeChainId;
  });

  process.env.ACTIVE_CHAIN_ID = "8453";
}

test("loadConfig rejects private keys with invalid format", (t) => {
  preserveConfigEnv(t);

  for (const privateKey of [
    "not-a-private-key",
    "1".repeat(64),
    `0x${"1".repeat(63)}`,
    `0x${"1".repeat(65)}`,
    `0x${"g".repeat(64)}`,
  ]) {
    process.env.WALLET_PRIVATE_KEY = privateKey;

    assert.throws(() => loadConfig(), {
      name: "Error",
      message: "Invalid private key format",
    });
  }
});

test("loadConfig rejects valid-format private keys that cannot produce an account", (t) => {
  preserveConfigEnv(t);

  for (const privateKey of [
    `0x${"0".repeat(64)}`,
    "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
    `0x${"f".repeat(64)}`,
  ]) {
    process.env.WALLET_PRIVATE_KEY = privateKey;

    assert.throws(() => loadConfig(), {
      name: "Error",
      message: "Private key does not parse to valid account",
    });
  }
});

test("loadConfig requires https for the API origin except on localhost", (t) => {
  preserveConfigEnv(t);
  const apiBaseUrl = process.env.API_BASE_URL;
  t.after(() => {
    if (apiBaseUrl === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = apiBaseUrl;
  });
  process.env.WALLET_PRIVATE_KEY = `0x${"0".repeat(63)}1`;

  for (const [url, expected] of [
    ["https://chainhilt.ai/api/v1/", "https://chainhilt.ai/api/v1"],
    ["http://localhost:3000/api/v1", "http://localhost:3000/api/v1"],
    ["http://127.0.0.1:3000/api/v1", "http://127.0.0.1:3000/api/v1"],
  ]) {
    process.env.API_BASE_URL = url;
    assert.equal(loadConfig().apiBaseUrl, expected);
  }

  for (const url of [
    "http://chainhilt.ai/api/v1",
    "http://localhost.attacker.example/api/v1",
    "ftp://localhost/api/v1",
  ]) {
    process.env.API_BASE_URL = url;
    assert.throws(() => loadConfig(), /API_BASE_URL must use https/);
  }
});

test("the key file is restricted to its owner, even when it already existed", (t) => {
  // restrictToOwner doesn't work on windows as it doesn't have unix-style file permissions
  // so the test is skipped for it
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "wallet-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const error = t.mock.method(console, "error", () => {});
  const path = join(dir, ".env");

  writeFileSync(path, "WALLET_PRIVATE_KEY=0x01\n", { mode: 0o644 });
  chmodSync(path, 0o644);
  restrictToOwner(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(error.mock.callCount(), 1);

  // Already owner-only: left alone, and nothing is logged.
  restrictToOwner(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(error.mock.callCount(), 1);
});
