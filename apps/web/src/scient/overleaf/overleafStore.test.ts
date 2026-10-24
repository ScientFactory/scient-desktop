import { EnvironmentId, type ScientOverleafStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const client = vi.hoisted(() => ({
  listOverleafConnections: vi.fn(),
  readOverleafStatus: vi.fn(),
  readOverleafToken: vi.fn(),
}));
vi.mock("./client", () => client);

const {
  forgetOverleafConnection,
  pendingOverleafDecisions,
  setOverleafFileDecision,
  beginOverleafPreview,
  finishOverleafPreview,
  recordOverleafSync,
  loadOverleafWorkspace,
  readOverleafWorkspace,
  refreshOverleafStatus,
  reloadOverleafWorkspaces,
  subscribeOverleafWorkspace,
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

  it("after an operation, every workspace view lists its links and reads their status again", async () => {
    resetOverleafStoreForTests();
    const WORKTREE = "/work/project-worktree";
    const HIDDEN = "/work/project-hidden";
    const OTHER = EnvironmentId.make("remote");
    client.listOverleafConnections
      .mockReset()
      .mockResolvedValue({ connections: [{ ...link, linkedHere: false }] });
    // Both views load while an operation in the main checkout holds the link.
    client.readOverleafStatus.mockReset().mockResolvedValue(status(true));
    await loadOverleafWorkspace(environmentId, ROOT);
    await loadOverleafWorkspace(environmentId, WORKTREE);
    await loadOverleafWorkspace(OTHER, ROOT);
    await loadOverleafWorkspace(environmentId, HIDDEN);
    // The worktree's view is on screen; HIDDEN was visited before and isn't.
    const unsubscribe = subscribeOverleafWorkspace(environmentId, WORKTREE, () => {});
    expect(readOverleafWorkspace(environmentId, WORKTREE).statuses.get("c1")?.busy).toBe(true);

    // The operation ends: the link is free, and a second link was connected.
    const second = { ...link, connectionId: "c2", folder: "thesis", linkedHere: false };
    client.listOverleafConnections
      .mockReset()
      .mockResolvedValue({ connections: [{ ...link, linkedHere: false }, second] });
    client.readOverleafStatus.mockReset().mockResolvedValue(status(false));
    await reloadOverleafWorkspaces(environmentId, ROOT);
    await vi.waitFor(() =>
      expect(
        readOverleafWorkspace(environmentId, WORKTREE).connections.map(
          (entry) => entry.connectionId,
        ),
      ).toEqual(["c1", "c2"]),
    );
    await vi.waitFor(() =>
      expect(readOverleafWorkspace(environmentId, WORKTREE).statuses.get("c1")?.busy).toBe(false),
    );
    expect(readOverleafWorkspace(environmentId, ROOT).statuses.get("c1")?.busy).toBe(false);
    // Another environment's views are left alone.
    expect(client.listOverleafConnections).not.toHaveBeenCalledWith(OTHER, ROOT);
    // A view not on screen reads nothing now, and reads again when next shown.
    expect(client.listOverleafConnections).not.toHaveBeenCalledWith(environmentId, HIDDEN);
    await loadOverleafWorkspace(environmentId, HIDDEN);
    expect(client.listOverleafConnections).toHaveBeenCalledWith(environmentId, HIDDEN);
    expect(readOverleafWorkspace(environmentId, HIDDEN).statuses.get("c1")?.busy).toBe(false);
    expect(readOverleafWorkspace(OTHER, ROOT).statuses.get("c1")?.busy).toBe(true);

    // An unlink: the link leaves every view.
    client.listOverleafConnections.mockReset().mockResolvedValue({ connections: [second] });
    await reloadOverleafWorkspaces(environmentId, ROOT);
    await vi.waitFor(() =>
      expect(
        readOverleafWorkspace(environmentId, WORKTREE).connections.map(
          (entry) => entry.connectionId,
        ),
      ).toEqual(["c2"]),
    );
    unsubscribe();
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

  it("a hidden view reopened while its earlier list is on its way reads afresh after another view's operation", async () => {
    resetOverleafStoreForTests();
    const HIDDEN = "/work/project-hidden";
    const before = deferred<{ connections: unknown[] }>();
    const second = { ...link, connectionId: "c2", folder: "thesis", linkedHere: false };
    client.listOverleafConnections
      .mockReset()
      .mockImplementation(async (_environment: unknown, root: string) =>
        root === ROOT ? { connections: [{ ...link, linkedHere: true }, second] } : before.promise,
      );
    client.readOverleafStatus.mockReset().mockResolvedValue(status(false));
    // The view starts listing, then leaves the screen before the answer comes.
    const unsubscribe = subscribeOverleafWorkspace(environmentId, HIDDEN, () => {});
    const earlier = loadOverleafWorkspace(environmentId, HIDDEN);
    unsubscribe();
    // An operation in the main checkout connects a second link; the hidden view is marked stale.
    await reloadOverleafWorkspaces(environmentId, ROOT);
    expect(client.listOverleafConnections).toHaveBeenCalledTimes(2);

    // Reopened before the earlier list answers: it reads afresh instead of joining it.
    client.listOverleafConnections.mockImplementation(async () => ({
      connections: [{ ...link, linkedHere: false }, second],
    }));
    const reopened = loadOverleafWorkspace(environmentId, HIDDEN);
    expect(client.listOverleafConnections).toHaveBeenCalledTimes(3);
    await reopened;
    // The earlier list, asked before the operation, answers last and is ignored.
    before.resolve({ connections: [{ ...link, linkedHere: false }] });
    await earlier;
    expect(
      readOverleafWorkspace(environmentId, HIDDEN).connections.map((entry) => entry.connectionId),
    ).toEqual(["c1", "c2"]);
  });

  it("a read of the changes that answers after a sync never replaces the sync's review", async () => {
    resetOverleafStoreForTests();
    const review = (reviewId: string) => ({
      reviewId,
      digest: "d",
      remoteTree: "a".repeat(40),
      upToDate: false,
      needsDecision: reviewId === "old",
      incoming: [],
      outgoing: [],
      conflicts: [],
      warnings: [],
      unresolvedMarkers: [],
      collisions: [],
      selectedAdditions: [],
      additions: [],
      localOnly: [],
    });
    // "Read changes" starts, a sync applies meanwhile, then the read answers.
    const started = beginOverleafPreview(environmentId, "c1");
    recordOverleafSync(environmentId, "c1", {
      _tag: "synced",
      settled: null,
      review: review("applied"),
      outcome: "complete",
      interrupted: 0,
      markerPaths: [],
      publication: { _tag: "accepted", attemptNumber: 1 },
      retried: false,
      activity: [],
      linkedElsewhere: false,
    });
    finishOverleafPreview(environmentId, "c1", started, {
      _tag: "review",
      review: review("old"),
    });
    const shown = readOverleafWorkspace(environmentId, ROOT);
    expect(shown.reviews.get("c1")).toMatchObject({
      review: { reviewId: "applied" },
      applied: true,
      sent: true,
    });
    expect(shown.previewing.has("c1")).toBe(false);

    // A read that started after it is current, but a failed one leaves the shown review.
    const failing = beginOverleafPreview(environmentId, "c1");
    finishOverleafPreview(environmentId, "c1", failing, { _tag: "failed", message: "x" });
    expect(readOverleafWorkspace(environmentId, ROOT).reviews.get("c1")?.review.reviewId).toBe(
      "applied",
    );
    const fresh = beginOverleafPreview(environmentId, "c1");
    finishOverleafPreview(environmentId, "c1", fresh, {
      _tag: "review",
      review: review("new"),
    });
    expect(readOverleafWorkspace(environmentId, ROOT).reviews.get("c1")).toMatchObject({
      review: { reviewId: "new" },
      applied: false,
    });
  });

  describe("pending decisions", () => {
    const withFiles = (
      reviewId: string,
      additions: ReadonlyArray<{ path: string; selected: boolean; skippedBecause: string | null }>,
      localOnly: ReadonlyArray<string> = [],
    ) => ({
      reviewId,
      digest: "d",
      remoteTree: "a".repeat(40),
      upToDate: false,
      needsDecision: false,
      incoming: [],
      outgoing: [],
      conflicts: [],
      warnings: [],
      unresolvedMarkers: [],
      collisions: [],
      selectedAdditions: [],
      additions: additions.map((addition) => ({ ...addition, size: 1 })),
      localOnly,
    });
    const accept = (review: ReturnType<typeof withFiles>) =>
      finishOverleafPreview(environmentId, "c1", beginOverleafPreview(environmentId, "c1"), {
        _tag: "review",
        review,
      });
    const pending = (root = ROOT) => [
      ...pendingOverleafDecisions(readOverleafWorkspace(environmentId, root), "c1"),
    ];

    it("a fresh review drops decisions it no longer allows, for good", () => {
      resetOverleafStoreForTests();
      accept(
        withFiles("r1", [{ path: "main.aux", selected: false, skippedBecause: "build-output" }]),
      );
      setOverleafFileDecision(environmentId, "c1", "main.aux", "send");
      expect(pending()).toEqual([["main.aux", "send"]]);
      // main.aux is deleted: the decision goes...
      accept(withFiles("r2", []));
      expect(readOverleafWorkspace(environmentId, ROOT).fileDecisions.get("c1")).toBeUndefined();
      // ...and a recreated main.aux doesn't bring it back.
      accept(
        withFiles("r3", [{ path: "main.aux", selected: false, skippedBecause: "build-output" }]),
      );
      expect(pending()).toEqual([]);
    });

    it("forgetting a link clears its review, decisions and carried record in every view", () => {
      resetOverleafStoreForTests();
      accept(withFiles("r1", [{ path: "draft.tex", selected: true, skippedBecause: null }]));
      setOverleafFileDecision(environmentId, "c1", "draft.tex", "keep");
      const late = beginOverleafPreview(environmentId, "c1");
      forgetOverleafConnection(environmentId, "c1");
      for (const root of [ROOT, "/work/project-wt"]) {
        const view = readOverleafWorkspace(environmentId, root);
        expect(view.reviews.has("c1")).toBe(false);
        expect(view.fileDecisions.has("c1")).toBe(false);
        expect(view.submittedDecisions.has("c1")).toBe(false);
      }
      // A read that started before is dropped.
      finishOverleafPreview(environmentId, "c1", late, {
        _tag: "review",
        review: withFiles("stale", []),
      });
      expect(readOverleafWorkspace(environmentId, ROOT).reviews.has("c1")).toBe(false);
    });

    it("one state per link: a decision made in a worktree's view counts in the main view", () => {
      resetOverleafStoreForTests();
      const MAIN = ROOT;
      const WORKTREE = "/work/project-wt";
      // Both views are read (and cached) before anything happens.
      readOverleafWorkspace(environmentId, MAIN);
      readOverleafWorkspace(environmentId, WORKTREE);
      accept(withFiles("r1", [{ path: "draft.tex", selected: true, skippedBecause: null }]));
      setOverleafFileDecision(environmentId, "c1", "draft.tex", "keep");
      expect(pending(MAIN)).toEqual([["draft.tex", "keep"]]);
      expect(pending(WORKTREE)).toEqual([["draft.tex", "keep"]]);
      // A sync that applies (here, from the main view) spends it in every view.
      recordOverleafSync(environmentId, "c1", {
        _tag: "synced",
        settled: null,
        review: withFiles("applied", []),
        outcome: "complete",
        interrupted: 0,
        markerPaths: [],
        publication: { _tag: "accepted", attemptNumber: 1 },
        retried: false,
        activity: [],
        linkedElsewhere: false,
      });
      expect(readOverleafWorkspace(environmentId, WORKTREE).fileDecisions.has("c1")).toBe(false);
      expect(readOverleafWorkspace(environmentId, WORKTREE).reviews.get("c1")?.applied).toBe(true);
    });
  });
});
