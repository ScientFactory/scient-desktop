import { describe, expect, it } from "@effect/vitest";

import { ompRpcArgs, OMP_RPC_ARGS } from "./OmpRpcProcess.ts";

describe("Oh My Pi launch arguments", () => {
  it("adds an explicit session directory without changing the core RPC contract", () => {
    expect(ompRpcArgs()).toEqual([...OMP_RPC_ARGS]);
    expect(ompRpcArgs("/state/omp/session", ["--no-session"])).toEqual([
      ...OMP_RPC_ARGS,
      "--session-dir",
      "/state/omp/session",
      "--no-session",
    ]);
  });
});
