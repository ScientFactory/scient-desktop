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
}
const path = process.argv[2];
if (path) {
  const job: WindowsCrashJob = JSON.parse(await NodeFSP.readFile(path, "utf8"));
  let nativeProcess: number | null = null;
  await mutateRetainedFile({ ...job.input, bytes: Buffer.from("incoming") }, job.target, {
    nativeProcess: (pid) => {
      nativeProcess = pid;
    },
    at: async (point) => {
      if (point === job.point) {
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
