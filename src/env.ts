import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { restrictToOwner } from "./wallet.js";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const localEnvPath = resolve(packageDir, ".env");

if (existsSync(localEnvPath)) {
  restrictToOwner(localEnvPath);
  loadEnvFile(localEnvPath);
}
