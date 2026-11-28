// @effect-diagnostics nodeBuiltinImport:off -- Loads each module alone in a fresh Node process.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

/** Imports one module, and nothing before it, in a Node process of its own. */
const loadsAlone = (path: string) =>
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(new URL(path, import.meta.url).href)}); console.log("loaded");`,
    ],
    { cwd: NodeURL.fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8" },
  ).trim();

it.each([
  "./AccountVault.ts",
  "./AccountsSecretStore.ts",
  "../../background/BackgroundPolicy.ts",
  "../../cli/restoreModelKeys.ts",
])("%s loads first, alone", (path) => {
  // regression: the vault and the policy imported each other through Server Settings, so a module
  // that came first reached a layer not yet defined.
  expect(loadsAlone(path)).toBe("loaded");
});
