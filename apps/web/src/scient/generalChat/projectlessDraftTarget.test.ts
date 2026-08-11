import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { startNewThreadForTarget } from "./projectlessDraftTarget";

const environmentId = EnvironmentId.make("environment-local");

describe("startNewThreadForTarget", () => {
  it("starts an environment-scoped General Chat draft without a project", () => {
    const calls: Array<{ environmentId: EnvironmentId; projectId: ProjectId | null }> = [];
    const targetRef = { environmentId, projectId: null };

    expect(
      startNewThreadForTarget(targetRef, (nextTargetRef) => {
        calls.push(nextTargetRef);
        return Promise.resolve();
      }),
    ).toBe(true);
    expect(calls).toEqual([targetRef]);
  });

  it("does not start a draft when no target is active", () => {
    let called = false;

    expect(
      startNewThreadForTarget(null, () => {
        called = true;
        return Promise.resolve();
      }),
    ).toBe(false);
    expect(called).toBe(false);
  });
});
