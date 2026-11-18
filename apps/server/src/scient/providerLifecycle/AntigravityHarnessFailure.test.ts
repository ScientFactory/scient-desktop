// @effect-diagnostics nodeBuiltinImport:off -- builds a real profile directory to read.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { readAntigravityUserToolServers } from "./AntigravityHarnessFailure.ts";

const roots: Array<string> = [];
const profile = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "antigravity-profile-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await NodeFSP.chmod(NodePath.join(root, "config"), 0o700).catch(() => undefined);
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

describe("readAntigravityUserToolServers", () => {
  it("reads the servers the user configured, and none when there is no file", async () => {
    const root = await profile();
    expect(await readAntigravityUserToolServers(root)).toEqual(new Set());
    await NodeFSP.mkdir(NodePath.join(root, "config"));
    await NodeFSP.writeFile(
      NodePath.join(root, "config", "mcp_config.json"),
      JSON.stringify({ mcpServers: { "my-tools": {} } }),
    );
    expect(await readAntigravityUserToolServers(root)).toEqual(new Set(["my-tools"]));
  });

  it("cannot tell when the configuration cannot be inspected", async () => {
    const root = await profile();
    const config = NodePath.join(root, "config");
    await NodeFSP.mkdir(config);
    await NodeFSP.writeFile(NodePath.join(config, "mcp_config.json"), "{}");
    await NodeFSP.chmod(config, 0o000);
    // Windows and a root user still inspect the file; only a refused inspection is tested.
    const refused = await NodeFSP.lstat(NodePath.join(config, "mcp_config.json")).then(
      () => false,
      () => true,
    );
    if (refused) expect(await readAntigravityUserToolServers(root)).toBeUndefined();
  });
});
