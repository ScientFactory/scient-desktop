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

const environmentId = EnvironmentId.make("local");
const ROOT = "/work/project";

describe("overleafActions", () => {
  beforeEach(() => {
    store.reloadOverleafWorkspaces.mockClear();
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
