// @effect-diagnostics nodeBuiltinImport:off -- Host-private per-command scratch, never manuscript files.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  observedDirectoryBinding,
  withNativeFilePublicationLease,
} from "../workspace/NativeFilePublication.ts";

export async function makeGitScratch(runtimeRoot: string, windows: boolean, helper?: string) {
  if (windows && helper === undefined) throw new Error("Private-directory helper unavailable.");
  const privateDirectory = async (directory: string): Promise<string> => {
    if (helper === undefined) {
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      return directory;
    }
    const parent = NodePath.dirname(directory);
    if (parent === directory) throw new Error("A volume root cannot hold Git scratch directly.");
    const canonicalParent = await NodeFSP.realpath(parent).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return privateDirectory(parent);
      },
    );
    const binding = await observedDirectoryBinding(helper, canonicalParent);
    // The helper pins the entire parent chain; scratch needs only its parent's exclusive lane.
    const result = await withNativeFilePublicationLease(
      helper,
      [binding],
      (lease) =>
        lease.runDirectory({
          binding,
          operation: "private-create",
          name: NodePath.basename(directory),
        }),
      { mode: "exclusive" },
    );
    // Scratch is disposable after a crash; only retained publication requires directory durability.
    if (result.code !== 0 || result.destinationAfter?.type !== "directory")
      throw new Error(`Private Git directory refused (${result.codeDomain}:${result.code}).`);
    return NodePath.join(canonicalParent, NodePath.basename(directory));
  };
  const root = await privateDirectory(runtimeRoot);
  for (const name of await NodeFSP.readdir(root)) {
    if (/^git-[A-Za-z0-9-]+$/u.test(name))
      await NodeFSP.rm(NodePath.join(root, name), { recursive: true, force: true });
  }
  return {
    create: () => privateDirectory(NodePath.join(root, `git-${NodeCrypto.randomUUID()}`)),
    remove: (directory: string) =>
      NodeFSP.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: windows ? 5 : 0,
      }),
  };
}
