// @effect-diagnostics nodeBuiltinImport:off
/**
 * Test child: one plain save through the file layer, then nothing. The test expects the
 * process to exit on its own. Usage: node Deadline.exit-child.ts <job.json>
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { makeApplierFiles } from "../overleaf/WorkspaceApplier.files.testkit.ts";
import { bytesRevision } from "./RetainedFileMutation.ts";

export interface SaveExitJob {
  readonly root: string;
  readonly cwd: string;
  readonly helper: string;
}

const jobPath = process.argv[2];
if (jobPath !== undefined) {
  const job: SaveExitJob = JSON.parse(await NodeFSP.readFile(jobPath, "utf8"));
  await NodeFSP.writeFile(NodePath.join(job.cwd, "main.tex"), "before\n");
  await Effect.runPromise(
    Effect.gen(function* () {
      const files = yield* makeApplierFiles({
        root: job.root,
        helper: job.helper,
        retainedHooks: {},
      });
      yield* files.writeFile({
        cwd: job.cwd,
        relativePath: "main.tex",
        contents: "after\n",
        expectedRevision: bytesRevision(Buffer.from("before\n")),
        mutationId: "save",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  process.stdout.write(await NodeFSP.readFile(NodePath.join(job.cwd, "main.tex"), "utf8"));
}
