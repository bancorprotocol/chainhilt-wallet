import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isAddressEqual, type Address, type Hex } from "viem";
import { loadKeychain, type Keychain } from "./keychain.js";
import { walletFileSchema } from "./validation.js";
import type { KeyStorage } from "./types.js";

export function walletHome(): string {
  return resolve(process.env.CHAINHILT_HOME || join(homedir(), ".chainhilt"));
}

export function parsePrivateKey(value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error("Invalid private key format");
  const key = value as Hex;
  try {
    privateKeyToAccount(key);
  } catch {
    throw new Error("Private key does not parse to valid account");
  }
  return key;
}

// Files holding the private key stay owner-only even when created by hand or
// restored from a backup with wider permissions. Windows has no such mode
// bits to tighten.
export function restrictToOwner(path: string): void {
  if (process.platform === "win32") {
    return;
  }
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    const restrictedMode = mode & 0o700;
    chmodSync(path, restrictedMode);
    console.error(
      `Restricted ${path} to 0${restrictedMode.toString(8)} (was ${mode.toString(8)}): it holds the wallet's private key.`,
    );
  }
}

function walletFiles() {
  const home = walletHome();
  return {
    home,
    keyFile: join(home, "wallet.key"),
    walletFile: join(home, "wallet.json"),
  };
}

const fileStorageRequested = () =>
  process.env.CHAINHILT_KEY_STORAGE === "file";

const walletFileAddress = (walletFile: string) =>
  walletFileSchema.parse(JSON.parse(readFileSync(walletFile, "utf8"))).address;

// wallet.json is checked before wallet.key because a migration publishes it
// before removing the key file.
function locateKey():
  | { keyStorage: "env" | "file"; key: Hex }
  | { keyStorage: "keychain"; address: Address; walletFile: string }
  | undefined {
  if (process.env.WALLET_PRIVATE_KEY) {
    return {
      keyStorage: "env",
      key: parsePrivateKey(process.env.WALLET_PRIVATE_KEY),
    };
  }
  const { home, keyFile, walletFile } = walletFiles();
  if (existsSync(walletFile)) {
    // Its address is the receive address, so no one else may replace it.
    restrictToOwner(home);
    restrictToOwner(walletFile);
    return {
      keyStorage: "keychain",
      address: walletFileAddress(walletFile),
      walletFile,
    };
  }
  if (existsSync(keyFile)) {
    restrictToOwner(home);
    restrictToOwner(keyFile);
    return {
      keyStorage: "file",
      key: parsePrivateKey(readFileSync(keyFile, "utf8").trim()),
    };
  }
  return undefined;
}

// Never reads the keychain, which can prompt the user on macOS.
export function readWallet():
  { address: Address; keyStorage: KeyStorage } | undefined {
  const located = locateKey();
  if (!located) return undefined;
  return {
    address:
      located.keyStorage === "keychain"
        ? located.address
        : privateKeyToAccount(located.key).address,
    keyStorage: located.keyStorage,
  };
}

export async function readPrivateKey(): Promise<Hex | undefined> {
  const located = locateKey();
  if (located?.keyStorage !== "keychain") return located?.key;
  const stored = await (await loadKeychain()).read(located.address);
  if (!stored) {
    throw new Error(
      `The OS keychain has no key for wallet ${located.address}. Restore it, or remove ${located.walletFile} to set up another wallet.`,
    );
  }
  const key = parsePrivateKey(stored);
  if (!isAddressEqual(privateKeyToAccount(key).address, located.address)) {
    throw new Error(
      `The OS keychain item for wallet ${located.address} holds another wallet's key.`,
    );
  }
  return key;
}

export function keyStorageWarning(keyStorage: KeyStorage): string | undefined {
  if (keyStorage === "env") {
    return "The private key comes from WALLET_PRIVATE_KEY, which is meant for development and CI only.";
  }
  if (keyStorage === "file") {
    return `The private key is stored in plain text in ${walletFiles().keyFile}, where any program running as this user, including an agent with shell access, can read it. ${
      fileStorageRequested()
        ? "Unset CHAINHILT_KEY_STORAGE=file to move it to the OS keychain."
        : "No OS keychain was available; on Linux, install and unlock a Secret Service such as GNOME Keyring, and the key moves there when the wallet next starts."
    }`;
  }
  return undefined;
}

function restrictAccess(path: string, directory = false) {
  if (process.platform !== "win32") {
    chmodSync(path, directory ? 0o700 : 0o600);
    return;
  }
  const username = process.env.USERDOMAIN
    ? `${process.env.USERDOMAIN}\\${userInfo().username}`
    : userInfo().username;
  execFileSync(
    "icacls.exe",
    [
      path,
      "/inheritance:r",
      "/grant:r",
      `${username}:${directory ? "(OI)(CI)" : ""}(F)`,
    ],
    { stdio: "ignore", windowsHide: true },
  );
}

function publish(file: string, contents: string) {
  const temporary = join(dirname(file), `.wallet-${randomUUID()}`);
  writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
  try {
    restrictAccess(temporary);
    // Linking publishes the file only once it is fully written and access-restricted
    // (Windows ACLs are applied after the write), and fails rather than replacing an existing wallet.
    linkSync(temporary, file);
  } finally {
    unlinkSync(temporary);
  }
}

const walletFileContents = (address: Address) =>
  `${JSON.stringify({ address, storage: "keychain" })}\n`;

async function storeInKeychain(keychain: Keychain, address: Address, key: Hex) {
  await keychain.write(address, key);
  if ((await keychain.read(address)) !== key) {
    throw new Error("The OS keychain did not return the key it stored.");
  }
}

async function keychainStores(address: Address, key: Hex) {
  try {
    await storeInKeychain(await loadKeychain(), address, key);
    return true;
  } catch (error) {
    console.error(
      `OS keychain unavailable (${error instanceof Error ? error.message : String(error)}); storing the key in ${walletFiles().keyFile}.`,
    );
    return false;
  }
}

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? error.code : undefined;

function tryLock(lock: string) {
  try {
    writeFileSync(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
}

function lockHolder(lock: string): number | undefined {
  let pid: number;
  try {
    pid = Number(readFileSync(lock, "utf8"));
  } catch (error) {
    // Released meanwhile.
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  // An empty lock was left by a setup killed while creating it.
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    // EPERM: the process runs, as another user.
    return errorCode(error) === "EPERM" ? pid : undefined;
  }
}

// The lock is taken, or a stale one replaced, only under this short-lived
// guard, so two setups that both find a stale lock cannot delete each other's.
async function acquireSetupLock(home: string) {
  const lock = join(home, "setup.lock");
  const guard = join(home, "setup.lock.guard");
  for (let attempt = 0; !tryLock(guard); attempt++) {
    if (attempt === 20) {
      throw new Error(
        `Another wallet setup is starting. If none is, remove ${guard}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    if (tryLock(lock)) return lock;
    const holder = lockHolder(lock);
    if (holder !== undefined) {
      throw new Error(
        `Another wallet setup is running (process ${holder}). If it is not, remove ${lock}.`,
      );
    }
    rmSync(lock, { force: true });
    if (!tryLock(lock)) throw new Error("Another wallet setup is running.");
    return lock;
  } finally {
    unlinkSync(guard);
  }
}

// One lock for both storage modes, held until the wallet is published. A lock
// whose process no longer runs was left by a killed setup and is taken over.
async function withSetupLock<T>(home: string, run: () => Promise<T>) {
  const lock = await acquireSetupLock(home);
  try {
    return await run();
  } finally {
    unlinkSync(lock);
  }
}

export async function saveWallet(privateKey?: string) {
  const key =
    privateKey === undefined
      ? generatePrivateKey()
      : parsePrivateKey(privateKey);
  const { address } = privateKeyToAccount(key);
  const { home, keyFile, walletFile } = walletFiles();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  restrictAccess(home, true);
  return withSetupLock(home, async () => {
    if (readWallet()) {
      throw new Error(
        "A wallet is already configured. Existing wallets are never replaced.",
      );
    }
    if (
      !fileStorageRequested() &&
      (await keychainStores(address, key))
    ) {
      // Only after the keychain returned the key, so an interrupted setup never shows a keyless wallet.
      publish(walletFile, walletFileContents(address));
      return { address, privateKey: key, keyStorage: "keychain" as const };
    }
    publish(keyFile, `${key}\n`);
    return { address, privateKey: key, keyStorage: "file" as const };
  });
}

// Moves a key file left by an earlier version into the OS keychain. The file
// is removed only after the keychain returns the key and wallet.json names
// its wallet; until then it stays in use.
export async function migrateKeyFile(): Promise<string | undefined> {
  const { home, keyFile, walletFile } = walletFiles();
  if (fileStorageRequested() || !existsSync(keyFile)) return undefined;
  // A restored folder may be writable by others, who could then replace wallet.json.
  restrictAccess(home, true);
  const key = parsePrivateKey(readFileSync(keyFile, "utf8").trim());
  const { address } = privateKeyToAccount(key);
  await storeInKeychain(await loadKeychain(), address, key);
  if (!existsSync(walletFile)) {
    publish(walletFile, walletFileContents(address));
  } else if (!isAddressEqual(walletFileAddress(walletFile), address)) {
    throw new Error(`${walletFile} names another wallet; ${keyFile} was kept.`);
  }
  unlinkSync(keyFile);
  return `Moved the wallet's private key from ${keyFile} into the OS keychain.`;
}
