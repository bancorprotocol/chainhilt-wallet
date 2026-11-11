import { getAddress, type Address, type Hex } from "viem";

// One item per wallet, named by its address, so storing a key never
// overwrites another wallet's.
const KEYCHAIN_SERVICE = "chainhilt";

export type Keychain = {
  read(address: Address): Promise<string | undefined>;
  write(address: Address, key: Hex): Promise<void>;
};

// A native module: imported only when a key is stored or read, so a platform
// without a prebuilt binary can fall back to the key file.
export async function loadKeychain(): Promise<Keychain> {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  // Linux otherwise falls back to the kernel keyring, which loses the key on reboot.
  const entry = (address: Address) =>
    new AsyncEntry(KEYCHAIN_SERVICE, getAddress(address), {
      linux: { store: "secret-service" },
    });
  return {
    read: async (address) => (await entry(address).getPassword()) ?? undefined,
    write: (address, key) => entry(address).setPassword(key),
  };
}
