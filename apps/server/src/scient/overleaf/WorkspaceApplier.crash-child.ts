// @effect-diagnostics nodeBuiltinImport:off
/**
 * Test child: runs one apply on the folders a test names and kills its own
 * process at a native publication hook, so the test can recover from a real
 * crash. A thrown hook is not one: the file layer's failure handler runs.
 * Usage: node WorkspaceApplier.crash-child.ts <job.json>
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import type { MutationPoint } from "../workspace/RetainedFileMutation.ts";
import { make, type WorkspaceApplyPlan } from "./WorkspaceApplier.ts";
import { makeApplierFiles } from "./WorkspaceApplier.files.testkit.ts";

export interface CrashJob {
  readonly root: string;
  readonly cwd: string;
  readonly owner: string;
  readonly helper: string;
  readonly id: string;
  readonly killAt: MutationPoint;
  /** Which time `killAt` is reached that kills the child: 1 for the first step. */
  readonly occurrence?: number;
  readonly plan: {
    readonly base: Record<string, string>;
    readonly remote: Record<string, string>;
    readonly captured: Record<string, string>;
    /** Base64 bytes by path. */
    readonly target: Record<string, string>;
    readonly renames: WorkspaceApplyPlan["renames"];
    readonly conflicts: WorkspaceApplyPlan["conflicts"];
    readonly markerPaths: WorkspaceApplyPlan["markerPaths"];
  };
}

const jobPath = process.argv[2];
if (jobPath !== undefined) {
  const job: CrashJob = JSON.parse(await NodeFSP.readFile(jobPath, "utf8"));
  let reached = 0;
  const plan: WorkspaceApplyPlan = {
    base: new Map(Object.entries(job.plan.base)),
    remote: new Map(Object.entries(job.plan.remote)),
    captured: new Map(Object.entries(job.plan.captured)),
    target: new Map(
      Object.entries(job.plan.target).map(([name, bytes]) => [
        name,
        { bytes: Buffer.from(bytes, "base64") },
      ]),
    ),
    renames: job.plan.renames,
    conflicts: job.plan.conflicts,
    markerPaths: job.plan.markerPaths,
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const files = yield* makeApplierFiles({
        root: job.root,
        helper: job.helper,
        retainedHooks: {
          at: async (point) => {
            if (point === job.killAt && ++reached === (job.occurrence ?? 1))
              process.kill(process.pid, "SIGKILL");
          },
        },
      });
      const applier = yield* make().pipe(Effect.provideService(WorkspaceFileSystem, files));
      yield* applier.apply({ cwd: job.cwd, applicationDirectory: job.owner, id: job.id, plan });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  // Reaching here means the hook never ran; the test sees a normal exit and fails.
}
