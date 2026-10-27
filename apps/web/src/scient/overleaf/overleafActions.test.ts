import { EnvironmentId, ThreadId } from "@t3tools/contracts";
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

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openScient: vi.fn() }) },
}));
const { seeOverleafChanges } = await import("./openOverleafReview");
const { cancelOverleafRun, readOverleafChanges } = await import("./overleafActions");
const { readOverleafWorkspace, resetOverleafStoreForTests, setOverleafSyncing } =
  await import("./overleafStore");

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
          heldWithMarked: [],
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
      "It first finished an interrupted sync, which wrote the folder. More than 250 MiB to sync. Keep some files only here, or choose a narrower folder.",
    );
    await readOverleafChanges(environmentId, ROOT, "c1");
    const after = readOverleafWorkspace(environmentId, ROOT);
    expect(after.previewErrors.has("c1")).toBe(false);
    expect(after.previewNotes.get("c1")).toBe(
      "It first finished an interrupted sync, which wrote the folder.",
    );
  });

  it("See changes refreshes an existing unapplied review and waits while a sync runs", async () => {
    client.previewOverleaf.mockReset().mockResolvedValue({
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
        heldWithMarked: [],
        released: [],
        collisions: [],
        selectedAdditions: [],
        additions: [],
        localOnly: [],
      },
      settled: null,
    });
    const input = { environmentId, cwd: ROOT, connectionId: "c1", folder: "paper" };
    const thread = { environmentId, threadId: ThreadId.make("t1") };
    await readOverleafChanges(environmentId, ROOT, "c1");
    const pending = Promise.withResolvers<never>();
    client.previewOverleaf.mockReturnValueOnce(pending.promise);
    seeOverleafChanges(thread, input);
    expect(client.previewOverleaf).toHaveBeenCalledTimes(2);
    expect(readOverleafWorkspace(environmentId, ROOT).previewing.has("c1")).toBe(true);
    seeOverleafChanges(thread, input);
    expect(client.previewOverleaf).toHaveBeenCalledTimes(2);
    pending.reject(new Error("offline"));
    await vi.waitFor(() =>
      expect(readOverleafWorkspace(environmentId, ROOT).previewing.has("c1")).toBe(false),
    );
    setOverleafSyncing(environmentId, "c1", true);
    seeOverleafChanges(thread, input);
    expect(client.previewOverleaf).toHaveBeenCalledTimes(2);
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
    // Nothing of this window's ran, so a newer revision it reads is someone else's sync.
    expect(store.reloadOverleafWorkspaces).toHaveBeenCalledWith(environmentId, ROOT, {
      afterOwnOperation: false,
    });
  });
});
