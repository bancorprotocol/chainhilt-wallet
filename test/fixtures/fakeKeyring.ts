import { registerHooks } from "node:module";
import { AsyncEntry as OsEntry, type EntryOptions } from "@napi-rs/keyring";
import type { Address, Hex } from "viem";
import type { Keychain } from "../../src/keychain.js";

// While set, it stands in for the OS keychain; unset, entries reach the real one.
export const fakeKeychain: { current?: Keychain } = {};

const keychainModule = new URL("../../src/keychain.ts", import.meta.url).href;

// `mock.module` from node:test needs --experimental-test-module-mocks, so
// src/keychain.ts's import of the native keyring resolves to this file instead.
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "@napi-rs/keyring" &&
      context.parentURL === keychainModule
      ? { url: import.meta.url, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});

export class AsyncEntry {
  readonly #address: Address;
  readonly #os: () => OsEntry;

  constructor(service: string, address: Address, options?: EntryOptions) {
    this.#address = address;
    this.#os = () => new OsEntry(service, address, options);
  }

  async getPassword() {
    const fake = fakeKeychain.current;
    if (!fake) return this.#os().getPassword();
    return (await fake.read(this.#address)) ?? null;
  }

  setPassword(key: Hex) {
    const fake = fakeKeychain.current;
    return fake ? fake.write(this.#address, key) : this.#os().setPassword(key);
  }
}
