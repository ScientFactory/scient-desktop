import { describe, expect, it } from "@effect/vitest";

import { redactOmpDiagnostic, ompRpcArgs, OMP_RPC_ARGS } from "./OmpRpcProcess.ts";

describe("Oh My Pi launch arguments", () => {
  it("adds an explicit session directory without changing the core RPC contract", () => {
    expect(ompRpcArgs()).toEqual([...OMP_RPC_ARGS]);
    expect(ompRpcArgs("/state/omp/session", ["--no-tools"])).toEqual([
      ...OMP_RPC_ARGS,
      "--session-dir",
      "/state/omp/session",
      "--no-tools",
    ]);
  });

  it("redacts common credential forms from diagnostics", () => {
    const value = redactOmpDiagnostic(
      "HOME=/Users/alice API_KEY=super-secret Bearer abc.def-ghi sk-test-1234567890",
      {
        HOME: "/Users/alice",
        API_KEY: "super-secret",
      },
    );
    expect(value).not.toContain("/Users/alice");
    expect(value).not.toContain("super-secret");
    expect(value).not.toContain("abc.def-ghi");
    expect(value).not.toContain("sk-test-1234567890");
  });
});
