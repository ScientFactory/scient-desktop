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
  await mutateRetainedFile({ ...job.input, bytes: Buffer.from("incoming") }, job.target, {
    at: async (point) => {
      if (point === job.point)
        NodeChildProcess.execFileSync(job.probe, ["--windows=1", "terminate", String(process.pid)]);
    },
  });
}
