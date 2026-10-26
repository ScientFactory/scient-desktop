// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import {
  mutateRetainedFile,
  type RetainedMutationInput,
  type MutationPoint,
} from "./RetainedFileMutation.ts";

export interface WindowsCrashJob {
  readonly input: RetainedMutationInput;
  readonly target: string;
  readonly point: MutationPoint;
  readonly probe: string;
  readonly occurrence?: number;
}
const path = process.argv[2];
if (path) {
  const job: WindowsCrashJob = JSON.parse(await NodeFSP.readFile(path, "utf8"));
  let nativeProcess: number | null = null,
    reached = 0;
  await mutateRetainedFile({ ...job.input, bytes: Buffer.from("incoming") }, job.target, {
    nativeProcess: (pid) => {
      nativeProcess = pid;
    },
    at: async (point) => {
      if (point === job.point && ++reached === (job.occurrence ?? 1)) {
        if (nativeProcess !== null)
          NodeChildProcess.execFileSync(job.probe, [
            "--windows=1",
            "terminate",
            String(nativeProcess),
          ]);
        NodeChildProcess.execFileSync(job.probe, ["--windows=1", "terminate", String(process.pid)]);
      }
    },
  });
}
