import { expect, it } from "@effect/vitest";
import { ORCHESTRATION_WS_METHODS as publicMethods } from "./index.ts";
import { ORCHESTRATION_WS_METHODS as legacyMethods } from "./orchestration.ts";
import { ORCHESTRATION_WS_METHODS } from "./scientOrchestrationRpcMethods.ts";

it("keeps one ordered current wire-name object across leaf, public and legacy exports", () => {
  expect(publicMethods).toBe(ORCHESTRATION_WS_METHODS);
  expect(legacyMethods).toBe(ORCHESTRATION_WS_METHODS);
  expect(Object.entries(ORCHESTRATION_WS_METHODS)).toEqual([
    ["dispatchCommand", "orchestration.dispatchCommand"],
    ["getForkOptions", "orchestration.getForkOptions"],
    ["getWorkflowScript", "orchestration.getWorkflowScript"],
    ["getTurnDiff", "orchestration.getTurnDiff"],
    ["getFullThreadDiff", "orchestration.getFullThreadDiff"],
    ["searchThreads", "orchestration.searchThreads"],
    ["getArchivedShellSnapshot", "orchestration.getArchivedShellSnapshot"],
    ["subscribeShell", "orchestration.subscribeShell"],
    ["subscribeThread", "orchestration.subscribeThread"],
  ]);
  expect(Object.isFrozen(ORCHESTRATION_WS_METHODS)).toBe(false);
});
