import { describe, expect, it } from "vite-plus/test";

import * as Public from "./index.ts";
import * as Historical from "./orchestration.ts";
import * as Snapshot from "./scientOrchestrationSnapshot.ts";

const bindings = {
  OrchestrationProject: Snapshot.OrchestrationProject,
  OrchestrationCheckpointSummary: Snapshot.OrchestrationCheckpointSummary,
  OrchestrationForkBoundary: Snapshot.OrchestrationForkBoundary,
  isForkBaselineBoundary: Snapshot.isForkBaselineBoundary,
  OrchestrationThread: Snapshot.OrchestrationThread,
  OrchestrationReadModel: Snapshot.OrchestrationReadModel,
  OrchestrationThreadShell: Snapshot.OrchestrationThreadShell,
  OrchestrationShellSnapshot: Snapshot.OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent: Snapshot.OrchestrationShellStreamEvent,
  OrchestrationShellStreamItem: Snapshot.OrchestrationShellStreamItem,
  OrchestrationSubscribeShellInput: Snapshot.OrchestrationSubscribeShellInput,
  OrchestrationSubscribeThreadInput: Snapshot.OrchestrationSubscribeThreadInput,
  OrchestrationThreadDetailWindow: Snapshot.OrchestrationThreadDetailWindow,
  OrchestrationThreadDetailPage: Snapshot.OrchestrationThreadDetailPage,
  OrchestrationThreadDetailSnapshot: Snapshot.OrchestrationThreadDetailSnapshot,
  OrchestrationThreadStreamItem: Snapshot.OrchestrationThreadStreamItem,
} satisfies {
  [Name in keyof typeof Snapshot]: (typeof Historical)[Name] & (typeof Public)[Name];
};

describe("Scient orchestration snapshot owner", () => {
  it("keeps every historical and public snapshot binding identical to its owner", () => {
    for (const name of Object.keys(bindings) as Array<keyof typeof bindings>) {
      expect(Historical[name]).toBe(bindings[name]);
      expect(Public[name]).toBe(bindings[name]);
    }
  });
});
