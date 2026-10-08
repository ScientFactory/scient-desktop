import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { afterAll } from "@effect/vitest";

/** Native cases compile the shipped C source rather than silently depending on a developer binary. */
export async function fileExchangeTestHelper() {
  if (
    HostProcessPlatform.defaultValue() !== "darwin" &&
    HostProcessPlatform.defaultValue() !== "linux"
  )
    return undefined;
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "scient-exchange-helper-"),
  );
  afterAll(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const helper = NodePath.join(directory, "scient-file-exchange");
  NodeChildProcess.execFileSync("cc", [
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    NodePath.resolve(import.meta.dirname, "../../../../../native/file-exchange/exchange.c"),
    "-o",
    helper,
  ]);
  return helper;
}
