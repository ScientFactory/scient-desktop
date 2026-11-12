import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { changeProjectSources, removedSnapshotCount } from "./libraryActions";

const mocks = vi.hoisted(() => ({ organizeScientSources: vi.fn() }));
vi.mock("./client", () => ({ organizeScientSources: mocks.organizeScientSources }));

const environmentId = "environment-1" as EnvironmentId;

describe("changeProjectSources", () => {
  it("removes many sources in one request and counts each as the server answered it", async () => {
    mocks.organizeScientSources.mockReset();
    mocks.organizeScientSources.mockResolvedValue({
      outcome: "updated",
      pinChanges: [
        { outcome: "unpinned", pin: { citationKey: "kept2020", sourceId: "src_kept" } },
        { outcome: "unpinned", pin: { citationKey: "gone2020", sourceId: "src_gone" } },
        { outcome: "not-pinned" },
        { outcome: "refused" },
      ],
    });
    const records = [
      { citationKey: "kept2020" },
      { citationKey: "gone2020", fromSnapshot: true },
      { citationKey: "moved2020", fromSnapshot: true },
      { citationKey: "odd2020", fromSnapshot: true },
    ];
    const changes = records.map((record) => ({
      action: "unpin" as const,
      citationKey: record.citationKey,
    }));

    const outcome = await changeProjectSources({ environmentId, root: "/project", changes });

    expect(mocks.organizeScientSources).toHaveBeenCalledTimes(1);
    expect(mocks.organizeScientSources).toHaveBeenCalledWith(environmentId, {
      root: "/project",
      change: { action: "change-pins", changes },
    });
    expect(outcome).toEqual({
      changed: 2,
      failed: 1,
      error: null,
      succeeded: changes.slice(0, 2),
    });
    // Only the snapshot whose unpin landed is gone from this computer.
    expect(removedSnapshotCount(records, outcome)).toBe(1);
  });

  it("counts every change failed when the request itself fails", async () => {
    mocks.organizeScientSources.mockReset();
    mocks.organizeScientSources.mockRejectedValue(new Error("The Library is not available."));
    const outcome = await changeProjectSources({
      environmentId,
      root: "/project",
      changes: [
        { action: "pin", sourceId: "src_a" },
        { action: "pin", sourceId: "src_b" },
      ],
    });
    expect(outcome).toEqual({
      changed: 0,
      failed: 2,
      error: "The Library is not available.",
      succeeded: [],
    });
  });
});
