import { describe, expect, it } from "vite-plus/test";
import type { ComputeManagedRuntimeStatus } from "@t3tools/contracts";

import { reconcileManagedRuntimeCommandSnapshot } from "./ComputeManagedRuntimeControls";

const existing: ComputeManagedRuntimeStatus = {
  installed: false,
  selection: "existing",
  updateAvailable: false,
  runtimeVersion: null,
  toolkitRevision: null,
  generationId: null,
  operation: null,
  failureMessage: null,
};
const installing: ComputeManagedRuntimeStatus = {
  ...existing,
  operation: {
    operationId: "operation-1",
    action: "install",
    phase: "installing-python",
    startedAt: "2026-09-14T12:00:00.000Z",
    downloadedBytes: null,
    totalBytes: null,
  },
};

describe("managed runtime command reconciliation", () => {
  it("shows an immediate command receipt while the query still has the old snapshot", () => {
    expect(
      reconcileManagedRuntimeCommandSnapshot({
        command: installing,
        querySnapshot: existing,
        currentQuery: existing,
      }),
    ).toBe(installing);
  });

  it("does not discard the receipt merely because a refetch is temporarily pending", () => {
    expect(
      reconcileManagedRuntimeCommandSnapshot({
        command: installing,
        querySnapshot: existing,
        currentQuery: undefined,
      }),
    ).toBe(installing);
  });

  it("yields to a later authoritative success or failure", () => {
    const installed = {
      ...existing,
      installed: true,
      generationId: "generation-1",
      runtimeVersion: "Python 3.12.13",
    } satisfies ComputeManagedRuntimeStatus;
    const failed = {
      ...existing,
      failure: {
        reason: "provision-failed",
        action: "install",
        summary: "Python setup failed",
        detail: "Package verification failed",
      },
      failureMessage: "Package verification failed",
    } satisfies ComputeManagedRuntimeStatus;
    for (const currentQuery of [installed, failed]) {
      expect(
        reconcileManagedRuntimeCommandSnapshot({
          command: installing,
          querySnapshot: existing,
          currentQuery,
        }),
      ).toBeNull();
    }
  });
});
