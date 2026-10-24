// @effect-diagnostics nodeBuiltinImport:off
/**
 * Test child: discards one kept version on the folders a test names and kills
 * its own process around a removal, so the test can recover from a real crash
 * mid-discard. Usage: node RetainedDiscard.crash-child.ts <job.json>
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { makeApplierFiles } from "./WorkspaceApplier.files.testkit.ts";

export interface DiscardCrashJob {
  readonly root: string;
  readonly cwd: string;
  readonly helper: string;
  readonly relativePath: string;
  readonly versionId: string;
  /** Die just before or just after removing the file at `path`. */
  readonly kill: { readonly when: "before" | "after"; readonly path: string };
}

const jobPath = process.argv[2];
if (jobPath !== undefined) {
  const job: DiscardCrashJob = JSON.parse(await NodeFSP.readFile(jobPath, "utf8"));
  // The module's mutable default export; `syncBuiltinESMExports` carries changes to imports.
  const MutableFSP = (NodeFSP as unknown as { default: { unlink: typeof NodeFSP.unlink } }).default;
  const unlink = MutableFSP.unlink;
  MutableFSP.unlink = async (path) => {
    const at = String(path) === job.kill.path;
    if (at && job.kill.when === "before") process.kill(process.pid, "SIGKILL");
    await unlink(path);
    if (at && job.kill.when === "after") process.kill(process.pid, "SIGKILL");
  };
  NodeModule.syncBuiltinESMExports();
  await Effect.runPromise(
    Effect.gen(function* () {
      const files = yield* makeApplierFiles({
        root: job.root,
        helper: job.helper,
        retainedHooks: {},
      });
      yield* files.discardFileVersion({
        cwd: job.cwd,
        relativePath: job.relativePath,
        versionId: job.versionId,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  // Reaching here means the removal never came; the test sees a normal exit and fails.
}
