import { EnvironmentId, type ScientOverleafStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const client = vi.hoisted(() => ({
  listOverleafConnections: vi.fn(),
  readOverleafStatus: vi.fn(),
  readOverleafToken: vi.fn(),
}));
vi.mock("./client", () => client);

const {
  loadOverleafWorkspace,
  readOverleafWorkspace,
  refreshOverleafStatus,
  resetOverleafStoreForTests,
} = await import("./overleafStore");

const environmentId = EnvironmentId.make("local");
const ROOT = "/work/project";

const link = {
  connectionId: "c1",
  checkoutRoot: ROOT,
  folder: "paper",
  projectId: "0123456789abcdef01234567",
  branch: "master" as const,
  state: "active" as const,
  completedSyncCount: 1,
  createdAt: "2026-10-24T10:00:00.000Z",
  updatedAt: "2026-10-24T10:00:00.000Z",
};

const status = (busy: boolean): ScientOverleafStatus => ({
  connection: link,
  availability: "ready",
  reasons: [],
  local: { _tag: "read", changed: 0, deleted: 0, added: 0 },
  markerPaths: [],
  unresolvedSends: 0,
  keptCopies: 0,
  busy,
  linkedElsewhere: false,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("overleafStore", () => {
  it("a status read that answers late never replaces a newer one", async () => {
    resetOverleafStoreForTests();
    const during = deferred<ScientOverleafStatus>();
    const after = deferred<ScientOverleafStatus>();
    client.readOverleafStatus
      .mockReset()
      .mockReturnValueOnce(during.promise)
      .mockReturnValueOnce(after.promise);
    // Read while the sync ran (busy), then again by the sync's own refresh.
    const first = refreshOverleafStatus(environmentId, ROOT, "c1");
    const second = refreshOverleafStatus(environmentId, ROOT, "c1");
    after.resolve(status(false));
    await second;
    during.resolve(status(true));
    await first;
    expect(readOverleafWorkspace(environmentId, ROOT).statuses.get("c1")?.busy).toBe(false);
  });

  it("a forced load starts afresh instead of joining a load already running", async () => {
    resetOverleafStoreForTests();
    const stale = deferred<{ connections: unknown[] }>();
    client.listOverleafConnections
      .mockReset()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ connections: [{ ...link, linkedHere: true }] });
    client.readOverleafStatus.mockReset().mockResolvedValue(status(false));
    const earlier = loadOverleafWorkspace(environmentId, ROOT);
    await loadOverleafWorkspace(environmentId, ROOT, { force: true });
    expect(client.listOverleafConnections).toHaveBeenCalledTimes(2);
    // The earlier list, from before the operation, answers last and is ignored.
    stale.resolve({ connections: [] });
    await earlier;
    expect(
      readOverleafWorkspace(environmentId, ROOT).connections.map((entry) => entry.connectionId),
    ).toEqual(["c1"]);
  });
});
