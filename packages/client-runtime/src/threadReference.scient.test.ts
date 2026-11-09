import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { scientHostedThreadOrigin } from "@t3tools/shared/scientThreadLinks";
import { describe, expect, it } from "vite-plus/test";

import { threadChipCopyTarget } from "./threadReference.ts";

const ref = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-1") };

describe("Scient Copy thread", () => {
  it("copies the in-app link until Scient names a hosted origin, then the hosted link", () => {
    const { contextId } = threadContextRecord(ref, "Fix the login flow");
    // Every web entry point passes the seam, as the sidebar does.
    expect(scientHostedThreadOrigin()).toBeUndefined();
    expect(threadChipCopyTarget(ref, "Fix the login flow", scientHostedThreadOrigin()).value).toBe(
      `[Fix the login flow](t3-context://v1/thread/${contextId})`,
    );
    expect(threadChipCopyTarget(ref, "Fix the login flow").value).not.toContain("t3.codes");

    expect(threadChipCopyTarget(ref, "Fix the login flow", "https://scient.example").value).toBe(
      "https://scient.example/threads/env-1/thread-1",
    );
  });
});
