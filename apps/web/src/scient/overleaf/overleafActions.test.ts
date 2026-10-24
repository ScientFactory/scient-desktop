import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const client = vi.hoisted(() => ({
  cancelOverleafSync: vi.fn(),
  overleafRequestId: vi.fn(() => "request"),
  previewOverleaf: vi.fn(),
  syncOverleaf: vi.fn(),
}));
vi.mock("./client", () => client);
const store = vi.hoisted(() => ({ reloadOverleafWorkspaces: vi.fn(async () => {}) }));
vi.mock("./overleafStore", async (original) => ({
  ...(await original<typeof import("./overleafStore")>()),
  reloadOverleafWorkspaces: store.reloadOverleafWorkspaces,
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn(), close: vi.fn() } }));

const { cancelOverleafRun, readOverleafChanges } = await import("./overleafActions");
const { readOverleafWorkspace, resetOverleafStoreForTests } = await import("./overleafStore");

const environmentId = EnvironmentId.make("local");
const ROOT = "/work/project";

describe("overleafActions", () => {
  beforeEach(() => {
    resetOverleafStoreForTests();
    store.reloadOverleafWorkspaces.mockClear();
  });

  it("says a read of the changes first finished an interrupted sync, whatever came next", async () => {
    const finished = { outcome: "complete", interrupted: 0, markerPaths: [] };
    client.previewOverleaf
      .mockReset()
      .mockResolvedValueOnce({
        _tag: "refused",
        refusal: { reason: "remote-too-large" },
        settled: finished,
      })
      .mockResolvedValueOnce({
        _tag: "review",
        review: {
          reviewId: "r",
          digest: "d",
          remoteTree: "a".repeat(40),
          upToDate: true,
          needsDecision: false,
          incoming: [],
          outgoing: [],
          conflicts: [],
          warnings: [],
          unresolvedMarkers: [],
          released: [],
          collisions: [],
          selectedAdditions: [],
          additions: [],
          localOnly: [],
        },
        settled: finished,
      });
    await readOverleafChanges(environmentId, ROOT, "c1");
    expect(readOverleafWorkspace(environmentId, ROOT).previewErrors.get("c1")).toBe(
      "It first finished an interrupted sync, which wrote the folder. More than 250 MiB to sync. Keep some files only on this computer, or choose a narrower folder.",
    );
    await readOverleafChanges(environmentId, ROOT, "c1");
    const after = readOverleafWorkspace(environmentId, ROOT);
    expect(after.previewErrors.has("c1")).toBe(false);
    expect(after.previewNotes.get("c1")).toBe(
      "It first finished an interrupted sync, which wrote the folder.",
    );
  });

  it("every view reads again after a read of the changes, even a failed one", async () => {
    // The read held the link, so a status read meanwhile said busy.
    client.previewOverleaf.mockReset().mockRejectedValueOnce(new Error("offline"));
    await readOverleafChanges(environmentId, ROOT, "c1");
    expect(store.reloadOverleafWorkspaces).toHaveBeenCalledWith(environmentId, ROOT);
  });

  it("every view reads again when a cancel finds no sync running", async () => {
    client.cancelOverleafSync.mockReset().mockResolvedValueOnce({ _tag: "nothing-running" });
    await cancelOverleafRun(environmentId, ROOT, "c1");
    expect(store.reloadOverleafWorkspaces).toHaveBeenCalledWith(environmentId, ROOT);
  });
});
