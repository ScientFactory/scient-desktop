import { render } from "../../../test/render";
import "../../index.css";

import {
  EnvironmentId,
  ThreadId,
  type ScientOverleafReview,
  type ScientOverleafSyncResult,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

import type { ChatComposerHandle } from "~/components/chat/ChatComposer";
import { ComposerHandleContext } from "~/composerHandleContext";

const client = vi.hoisted(() => ({
  readOverleafToken: vi.fn(),
  saveOverleafToken: vi.fn(),
  removeOverleafToken: vi.fn(),
  connectOverleaf: vi.fn(),
  syncOverleaf: vi.fn(),
  previewOverleaf: vi.fn(),
  readOverleafDiff: vi.fn(),
  listOverleafConnections: vi.fn(),
  readOverleafStatus: vi.fn(),
  listOverleafKeptCopies: vi.fn(),
  restoreOverleafKeptCopy: vi.fn(),
  disconnectOverleaf: vi.fn(),
  cancelOverleafSync: vi.fn(),
  listOverleafUndoableSends: vi.fn(),
  undoOverleafSend: vi.fn(),
}));
vi.mock("./client", () => ({ ...client, overleafRequestId: () => "request-1" }));
const toasts = vi.hoisted(() => ({ add: vi.fn(() => "toast"), close: vi.fn() }));
vi.mock("~/components/ui/toast", () => ({ toastManager: toasts }));

// Starting a thread on the linked copy goes through the app's own new-thread path.
const threads = vi.hoisted(() => ({
  handle: vi.fn(),
  projects: [] as Array<{ environmentId: string; id: string; workspaceRoot: string }>,
  shellProjectId: null as string | null,
}));
vi.mock("~/hooks/useHandleNewThread", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useHandleNewThread")>()),
  useNewThreadHandler: () => threads.handle,
}));
vi.mock("~/state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/entities")>()),
  readProjects: () => threads.projects,
  readThreadShell: () =>
    threads.shellProjectId === null ? null : { projectId: threads.shellProjectId },
}));

// The thread the window shows when the sync finishes.
const shown = vi.hoisted(() => ({ thread: null as unknown }));
vi.mock("./overleafThreadTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./overleafThreadTarget")>()),
  useReadShownThread: () => () => shown.thread,
}));

const { useComposerDraftStore } = await import("~/composerDraftStore");
const { useRightPanelStore } = await import("~/rightPanelStore");
const { scopedThreadKey } = await import("@t3tools/client-runtime/environment");
const { OverleafReviewPanel } = await import("./OverleafReviewPanel");
const { readOverleafWorkspace, recordOverleafSync, resetOverleafStoreForTests } =
  await import("./overleafStore");

const environmentId = EnvironmentId.make("local");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };
const ID = "0123456789abcdef01234567";

const connection = {
  connectionId: "c1",
  checkoutRoot: "/work/project",
  folder: "paper",
  projectId: ID,
  branch: "master" as const,
  state: "active" as const,
  completedSyncCount: 2,
  createdAt: "2026-10-24T10:00:00.000Z",
  updatedAt: "2026-10-24T10:00:00.000Z",
  linkedHere: true,
};

function review(overrides: Partial<ScientOverleafReview> = {}): ScientOverleafReview {
  return {
    reviewId: "r1",
    digest: "d1",
    remoteTree: "a".repeat(40),
    upToDate: false,
    needsDecision: true,
    incoming: [{ kind: "modified", path: "refs.bib" }],
    outgoing: [{ kind: "added", path: "figures/plot.pdf" }],
    conflicts: [
      {
        key: "k-main",
        paths: ["main.tex"],
        allowed: ["mine", "theirs", "markers"],
        chosen: null,
      },
      {
        key: "k-intro",
        paths: ["intro.tex"],
        allowed: ["mine", "theirs", "markers"],
        chosen: null,
      },
      // A conflict across several files keeps the engine's two whole-group choices.
      { key: "k-group", paths: ["old.tex", "new.tex"], allowed: ["mine", "theirs"], chosen: null },
    ],
    warnings: [],
    unresolvedMarkers: [],
    heldWithMarked: [],
    released: [],
    collisions: [],
    selectedAdditions: [],
    additions: [],
    localOnly: [],
    ...overrides,
  };
}

const decision: ScientOverleafSyncResult = {
  _tag: "needs-decision",
  retried: false,
  settled: null,
  review: review(),
  activity: [],
  linkedElsewhere: false,
};

const applied: ScientOverleafSyncResult = {
  _tag: "synced",
  settled: null,
  review: review({ needsDecision: false, conflicts: [] }),
  outcome: "attention",
  interrupted: 0,
  markerPaths: ["main.tex", "intro.tex"],
  publication: { _tag: "blocked", reason: "markers" },
  retried: false,
  activity: [],
  linkedElsewhere: false,
};

function composerStub() {
  const insertTextAtEnd = vi.fn(() => true);
  const focusAtEnd = vi.fn();
  const ref = { current: { insertTextAtEnd, focusAtEnd } as unknown as ChatComposerHandle };
  return { ref, insertTextAtEnd, focusAtEnd };
}

function reset() {
  resetOverleafStoreForTests();
  shown.thread = threadRef;
  for (const mock of Object.values(client)) mock.mockReset();
  toasts.add.mockClear();
  client.listOverleafConnections.mockResolvedValue({ connections: [connection] });
  client.readOverleafStatus.mockRejectedValue(new Error("not needed"));
  client.syncOverleaf.mockResolvedValue(applied);
}

const panel = (onOpenFile: (path: string) => void = () => {}) => (
  <OverleafReviewPanel
    environmentId={environmentId}
    cwd="/work/project"
    connectionId="c1"
    threadRef={threadRef}
    onOpenFile={onOpenFile}
  />
);

describe("OverleafReviewPanel", () => {
  it("shows Overleaf line changes in the review and asks to check again for a stale review", async () => {
    reset();
    recordOverleafSync(environmentId, "c1", decision);
    client.readOverleafDiff.mockResolvedValueOnce({
      _tag: "diff",
      reviewId: "r1",
      incoming: [
        {
          _tag: "text",
          path: "refs.bib",
          before: "old reference\n",
          after: "incoming reference\n",
        },
      ],
      outgoing: [
        { _tag: "text", path: "main.tex", before: "old text\n", after: "outgoing text\n" },
        { _tag: "not-shown", path: "plot.pdf", reason: "binary" },
      ],
    });
    await using _screen = await render(panel());
    await page.getByRole("button", { name: "Show in Diff" }).click();
    const incoming = page.getByRole("region", { name: "From Overleaf" });
    const outgoing = page.getByRole("region", { name: "To Overleaf" });
    await expect.element(incoming.getByText("incoming reference", { exact: true })).toBeVisible();
    await expect.element(outgoing.getByText("outgoing text", { exact: true })).toBeVisible();
    await expect
      .element(outgoing.getByText("plot.pdf: Binary file; diff not shown."))
      .toBeVisible();
    expect(client.readOverleafDiff).toHaveBeenCalledWith(environmentId, {
      workspaceRoot: "/work/project",
      connectionId: "c1",
      reviewId: "r1",
    });
    client.readOverleafDiff.mockResolvedValueOnce({ _tag: "stale", reason: "check-again" });
    await page.getByRole("button", { name: "Show in Diff" }).click();
    await expect
      .element(page.getByText("This review is no longer current. Check again to see its diff."))
      .toBeVisible();
    await expect.element(incoming).not.toBeInTheDocument();
  });

  it("offers four choices per file conflict and two for a group, then syncs again with them", async () => {
    reset();
    recordOverleafSync(environmentId, "c1", decision);
    const composer = composerStub();
    await using _screen = await render(
      <ComposerHandleContext value={composer.ref}>{panel()}</ComposerHandleContext>,
    );
    const main = page.getByRole("group", { name: "Settle main.tex" });
    await expect.element(main).toBeVisible();
    for (const label of ["Keep mine", "Use Overleaf's", "Merge myself", "Ask the agent"]) {
      await expect.element(main.getByRole("button", { name: label })).toBeVisible();
    }
    const group = page.getByRole("group", { name: "Settle old.tex" });
    await expect.element(group.getByRole("button", { name: "Keep mine" })).toBeVisible();
    await expect
      .element(group.getByRole("button", { name: "Merge myself" }))
      .not.toBeInTheDocument();

    const syncAgain = page.getByRole("button", { name: "Sync again" });
    await expect.element(syncAgain).toBeDisabled();
    await main.getByRole("button", { name: "Ask the agent" }).click();
    await page
      .getByRole("group", { name: "Settle intro.tex" })
      .getByRole("button", { name: "Merge myself" })
      .click();
    await expect.element(syncAgain).toBeDisabled();
    await group.getByRole("button", { name: "Use Overleaf's" }).click();
    await syncAgain.click();

    await expect.poll(() => client.syncOverleaf.mock.calls.length).toBe(1);
    // "Ask the agent" writes the marks, like "Merge myself".
    expect(client.syncOverleaf).toHaveBeenCalledWith(environmentId, {
      workspaceRoot: "/work/project",
      connectionId: "c1",
      requestId: "request-1",
      choices: [
        { key: "k-main", choice: "markers" },
        { key: "k-intro", choice: "markers" },
        { key: "k-group", choice: "theirs" },
      ],
      // The choices answer these conflicts as they stood against this Overleaf tree.
      reviewedRemote: "a".repeat(40),
    });
    // Then the chat gets a message asking the agent to merge main.tex only.
    await expect.poll(() => composer.insertTextAtEnd.mock.calls.length).toBe(1);
    const [message] = composer.insertTextAtEnd.mock.calls[0] as unknown as [string];
    expect(message).toContain("- paper/main.tex");
    expect(message).not.toContain("intro.tex");
    expect(composer.focusAtEnd).toHaveBeenCalledOnce();
    // The result replaces the conflicts: marks hold the send back, and says so.
    await expect
      .element(
        page.getByText(
          "Nothing was sent: 2 files still have conflict marks. Settle them and sync again.",
        ),
      )
      .toBeVisible();
  });

  it("lists what came in and what is to send, and opens a file from the list", async () => {
    reset();
    client.previewOverleaf.mockResolvedValue({
      _tag: "review",
      review: review({
        needsDecision: false,
        conflicts: [],
        selectedAdditions: ["figures/plot.pdf"],
        additions: [{ path: "figures/plot.pdf", size: 10, selected: true, skippedBecause: null }],
      }),
    });
    const onOpenFile = vi.fn();
    await using _screen = await render(panel(onOpenFile));
    // Without a sync in this window, the tab reads the changes when asked.
    await page.getByRole("button", { name: "Read changes" }).click();
    const incoming = page.getByRole("region", { name: "To bring in" });
    await expect.element(incoming.getByText("refs.bib")).toBeVisible();
    await expect
      .element(page.getByRole("region", { name: "To send" }).getByText("figures/plot.pdf"))
      .toBeVisible();
    // New files go by default; the review says how many.
    await expect
      .element(page.getByRole("region", { name: "New files" }).getByText("1 will be sent"))
      .toBeVisible();
    await incoming.getByText("refs.bib").click();
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("paper/refs.bib");
    expect(client.previewOverleaf).toHaveBeenCalledExactlyOnceWith(environmentId, {
      workspaceRoot: "/work/project",
      connectionId: "c1",
    });
  });

  it("says when reading the changes first finished an interrupted sync", async () => {
    reset();
    client.previewOverleaf.mockResolvedValue({
      _tag: "review",
      review: review({ needsDecision: false, conflicts: [] }),
      settled: { outcome: "complete", interrupted: 0, markerPaths: [] },
    });
    await using _screen = await render(panel());
    await page.getByRole("button", { name: "Read changes" }).click();
    await expect
      .element(page.getByText("It first finished an interrupted sync, which wrote the folder."))
      .toBeVisible();
  });

  it("sends a file waiting for its conflicts anyway, at the next sync", async () => {
    reset();
    client.previewOverleaf.mockResolvedValue({
      _tag: "review",
      review: review({ needsDecision: false, conflicts: [], unresolvedMarkers: ["guide.md"] }),
      settled: null,
    });
    await using _screen = await render(panel());
    await page.getByRole("button", { name: "Read changes" }).click();
    const waiting = page.getByRole("region", { name: "Waiting for conflicts" });
    await waiting.getByRole("button", { name: "Send it anyway: guide.md" }).click();
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect.poll(() => client.syncOverleaf.mock.calls.length).toBe(1);
    expect(client.syncOverleaf.mock.calls[0]![1]).toMatchObject({
      files: { release: ["guide.md"] },
    });
  });

  it("offers Undo after a sync that sent, for that send", async () => {
    reset();
    client.listOverleafUndoableSends.mockResolvedValue({
      sends: [
        {
          attemptNumber: 7,
          recordedAt: "2026-10-24T12:00:00.000Z",
          changes: [{ kind: "added", path: "figures/plot.pdf" }],
        },
      ],
    });
    // A sync that stopped at marks sent nothing: nothing to undo.
    recordOverleafSync(environmentId, "c1", applied);
    await using _screen = await render(panel());
    await expect.element(page.getByText("refs.bib")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Undo send" })).not.toBeInTheDocument();
    recordOverleafSync(environmentId, "c1", {
      ...applied,
      outcome: "complete",
      markerPaths: [],
      publication: { _tag: "accepted", attemptNumber: 7 },
    });
    await page.getByRole("button", { name: "Undo send" }).click();
    await expect.element(page.getByText("Undo send #7")).toBeVisible();
    await expect
      .element(page.getByRole("list", { name: "What Undo puts back" }).getByText("Removed"))
      .toBeVisible();
  });

  it("keeps choices after opening a file and remounting, then carries them in header Sync", async () => {
    reset();
    recordOverleafSync(environmentId, "c1", decision);
    const onOpenFile = vi.fn();
    {
      await using _screen = await render(panel(onOpenFile));
      for (const path of ["main.tex", "intro.tex", "old.tex"])
        await page
          .getByRole("group", { name: `Settle ${path}` })
          .getByRole("button", { name: "Keep mine" })
          .click();
      await page.getByRole("button", { name: "main.tex", exact: true }).click();
      expect(onOpenFile).toHaveBeenCalledWith("paper/main.tex");
    }
    await using _screen = await render(panel());
    await expect.element(page.getByRole("button", { name: "Sync again" })).toBeEnabled();
    await expect
      .element(
        page
          .getByRole("group", { name: "Settle main.tex" })
          .getByRole("button", { name: "Keep mine" }),
      )
      .toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect.poll(() => client.syncOverleaf.mock.calls.length).toBe(1);
    expect(client.syncOverleaf.mock.calls[0]![1]).toMatchObject({
      choices: [
        { key: "k-main", choice: "mine" },
        { key: "k-intro", choice: "mine" },
        { key: "k-group", choice: "mine" },
      ],
      reviewedRemote: "a".repeat(40),
    });
  });

  it("shows the conflicts again when Overleaf moved after the choices were made", async () => {
    reset();
    recordOverleafSync(environmentId, "c1", decision);
    // Overleaf moved: the server answers with a fresh review instead of applying.
    const fresh = review({
      remoteTree: "b".repeat(40),
      conflicts: [
        { key: "k-new", paths: ["main.tex"], allowed: ["mine", "theirs", "markers"], chosen: null },
      ],
    });
    client.syncOverleaf.mockResolvedValue({ ...decision, review: fresh });
    const composer = composerStub();
    await using _screen = await render(
      <ComposerHandleContext value={composer.ref}>{panel()}</ComposerHandleContext>,
    );
    for (const path of ["main.tex", "intro.tex", "old.tex"]) {
      await page
        .getByRole("group", { name: `Settle ${path}` })
        .getByRole("button", { name: "Keep mine" })
        .click();
    }
    await page.getByRole("button", { name: "Sync again" }).click();
    await expect
      .element(page.getByText("Overleaf changed since you chose. Choose again."))
      .toBeVisible();
    // Only the fresh conflict is offered, with nothing chosen yet.
    await expect
      .element(page.getByRole("group", { name: "Settle intro.tex" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Sync again" })).toBeDisabled();
    expect(composer.insertTextAtEnd).not.toHaveBeenCalled();

    await page
      .getByRole("group", { name: "Settle main.tex" })
      .getByRole("button", { name: "Use Overleaf's" })
      .click();
    client.syncOverleaf.mockResolvedValue(applied);
    await page.getByRole("button", { name: "Sync again" }).click();
    await expect.poll(() => client.syncOverleaf.mock.calls.length).toBe(2);
    expect(client.syncOverleaf.mock.calls[1]![1]).toMatchObject({
      choices: [{ key: "k-new", choice: "theirs" }],
      reviewedRemote: "b".repeat(40),
    });
  });

  it("cancels a running sync from the tab", async () => {
    reset();
    let finish!: (result: ScientOverleafSyncResult) => void;
    client.syncOverleaf.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    client.cancelOverleafSync.mockResolvedValue({ _tag: "requested", operationId: "op-1" });
    recordOverleafSync(environmentId, "c1", applied);
    await using _screen = await render(panel());
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(client.cancelOverleafSync).toHaveBeenCalledExactlyOnceWith(environmentId, {
      workspaceRoot: "/work/project",
      connectionId: "c1",
    });
    finish({ _tag: "cancelled", stage: "before-apply", retried: false, settled: null });
    await expect.element(page.getByText("Sync cancelled")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("keeps the conflicts and their choices when a retry is cancelled or refused", async () => {
    reset();
    recordOverleafSync(environmentId, "c1", decision);
    await using _screen = await render(panel());
    for (const path of ["main.tex", "intro.tex", "old.tex"])
      await page
        .getByRole("group", { name: `Settle ${path}` })
        .getByRole("button", { name: "Keep mine" })
        .click();
    const keepMain = page
      .getByRole("group", { name: "Settle main.tex" })
      .getByRole("button", { name: "Keep mine" });
    for (const [index, result] of [
      { _tag: "cancelled", stage: "before-apply", retried: false, settled: null },
      { _tag: "refused", refusal: { reason: "unreachable" }, retried: false, settled: null },
    ].entries()) {
      client.syncOverleaf.mockResolvedValueOnce(result);
      await page.getByRole("button", { name: "Sync again" }).click();
      await expect.poll(() => client.syncOverleaf.mock.calls.length).toBe(index + 1);
      await expect
        .element(page.getByText(index === 0 ? "Sync cancelled" : "Couldn't sync with Overleaf"))
        .toBeVisible();
      // The review it was, with its conflict controls and choices, is still there.
      await expect.element(keepMain).toHaveAttribute("aria-pressed", "true");
      await expect.element(page.getByRole("button", { name: "Sync again" })).toBeEnabled();
      await expect
        .element(page.getByRole("button", { name: "Read changes" }))
        .not.toBeInTheDocument();
    }
  });

  it("forgets choices when another review replaces the one they were made on", async () => {
    reset();
    recordOverleafSync(environmentId, "c1", decision);
    // The header's Sync finds the same files in conflict, against a newer Overleaf.
    client.syncOverleaf.mockResolvedValue({
      ...decision,
      review: review({ reviewId: "r2", remoteTree: "c".repeat(40) }),
    });
    await using _screen = await render(panel());
    const keepMain = page
      .getByRole("group", { name: "Settle main.tex" })
      .getByRole("button", { name: "Keep mine" });
    for (const path of ["main.tex", "intro.tex", "old.tex"])
      await page
        .getByRole("group", { name: `Settle ${path}` })
        .getByRole("button", { name: "Keep mine" })
        .click();
    await expect.element(keepMain).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect.poll(() => client.syncOverleaf.mock.calls.length).toBe(1);
    await expect.element(keepMain).toHaveAttribute("aria-pressed", "false");
    await expect.element(page.getByRole("button", { name: "Sync again" })).toBeDisabled();
  });

  it("writes Ask the agent into the thread that asked, even after moving to another", async () => {
    reset();
    recordOverleafSync(environmentId, "c1", decision);
    // By the time the sync finishes, the window shows another thread.
    shown.thread = { environmentId, threadId: ThreadId.make("thread-2") };
    const setPrompt = vi.fn();
    const getState = useComposerDraftStore.getState;
    using _spy = vi
      .spyOn(useComposerDraftStore, "getState")
      .mockImplementation(() => ({ ...getState(), getComposerDraft: () => null, setPrompt }));
    const composer = composerStub();
    await using _screen = await render(
      <ComposerHandleContext value={composer.ref}>{panel()}</ComposerHandleContext>,
    );
    for (const [path, choice] of [
      ["main.tex", "Ask the agent"],
      ["intro.tex", "Keep mine"],
      ["old.tex", "Keep mine"],
    ] as const)
      await page
        .getByRole("group", { name: `Settle ${path}` })
        .getByRole("button", { name: choice })
        .click();
    await page.getByRole("button", { name: "Sync again" }).click();
    await expect.poll(() => setPrompt.mock.calls.length).toBe(1);
    expect(setPrompt.mock.calls[0]![0]).toEqual(threadRef);
    expect(setPrompt.mock.calls[0]![1]).toContain("- paper/main.tex");
    // The composer on screen belongs to the other thread: it is left alone.
    expect(composer.insertTextAtEnd).not.toHaveBeenCalled();
  });

  it("checks again after an earlier sync, so new files can be decided before they are sent", async () => {
    reset();
    recordOverleafSync(environmentId, "c1", {
      ...applied,
      publication: { _tag: "accepted", attemptNumber: 1 },
      review: review({ needsDecision: false, conflicts: [] }),
    });
    await using _screen = await render(panel());
    await expect.element(page.getByRole("region", { name: "Came in" })).toBeVisible();

    // A failed read leaves the review that was shown.
    client.previewOverleaf.mockResolvedValueOnce({
      _tag: "refused",
      refusal: { reason: "unreachable" },
    });
    await page.getByRole("button", { name: "Check again" }).click();
    await expect
      .element(page.getByText("Overleaf couldn't be reached. Check the connection and sync again."))
      .toBeVisible();
    await expect.element(page.getByRole("region", { name: "Came in" })).toBeVisible();

    client.previewOverleaf.mockResolvedValueOnce({
      _tag: "review",
      review: review({
        needsDecision: false,
        conflicts: [],
        additions: [{ path: "draft.tex", size: 10, selected: true, skippedBecause: null }],
      }),
    });
    await page.getByRole("button", { name: "Try again" }).click();
    await expect
      .element(page.getByRole("button", { name: "Keep only here: draft.tex" }))
      .toBeVisible();
    await expect.element(page.getByRole("region", { name: "To bring in" })).toBeVisible();
  });

  describe("per-file decisions", () => {
    const newFiles = review({
      needsDecision: false,
      conflicts: [],
      selectedAdditions: ["figures/plot.pdf"],
      additions: [
        { path: "figures/plot.pdf", size: 10, selected: true, skippedBecause: null },
        { path: "main.aux", size: 10, selected: false, skippedBecause: "build-output" },
        { path: "data/raw.bin", size: 60_000_000, selected: false, skippedBecause: "too-large" },
      ],
      localOnly: ["notes.md"],
    });

    async function readNewFiles() {
      reset();
      client.previewOverleaf.mockResolvedValue({ _tag: "review", review: newFiles, settled: null });
      const screen = await render(panel());
      await page.getByRole("button", { name: "Read changes" }).click();
      await expect.element(page.getByRole("region", { name: "New files" })).toBeVisible();
      return screen;
    }

    it("drops decisions a fresh read no longer allows, and keeps the rest through a refusal", async () => {
      await using _screen = await readNewFiles();
      await page.getByRole("button", { name: "Send this file: main.aux" }).click();
      await page.getByRole("button", { name: "Send this file: notes.md" }).click();
      await page.getByRole("button", { name: "Keep only here: figures/plot.pdf" }).click();

      // main.aux was deleted, and figures/plot.pdf is now over Overleaf's limit.
      client.previewOverleaf.mockResolvedValue({
        _tag: "review",
        review: review({
          needsDecision: false,
          conflicts: [],
          additions: [
            {
              path: "figures/plot.pdf",
              size: 60_000_000,
              selected: false,
              skippedBecause: "too-large",
            },
            { path: "draft.tex", size: 10, selected: true, skippedBecause: null },
          ],
          localOnly: ["notes.md"],
        }),
      });
      await page.getByRole("button", { name: "Check again" }).click();
      await expect
        .element(page.getByRole("button", { name: "Send this file: main.aux" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Send this file: notes.md" }))
        .toHaveAttribute("aria-pressed", "true");

      client.syncOverleaf.mockResolvedValue({
        _tag: "refused",
        refusal: { reason: "unreachable" },
      });
      await page.getByRole("button", { name: "Sync", exact: true }).click();
      await expect.poll(() => client.syncOverleaf.mock.calls.length).toBe(1);
      // Only what this review still lists and allows is sent.
      expect(client.syncOverleaf.mock.calls[0]![1]).toMatchObject({
        files: { send: ["notes.md"] },
      });
      expect(client.syncOverleaf.mock.calls[0]![1].files).not.toHaveProperty("keepOnlyHere");

      // The refusal changes nothing about the decisions: the next Sync carries them again.
      await page.getByRole("button", { name: "Sync", exact: true }).click();
      await expect.poll(() => client.syncOverleaf.mock.calls.length).toBe(2);
      expect(client.syncOverleaf.mock.calls[1]![1]).toMatchObject({
        files: { send: ["notes.md"] },
      });
    });

    it("keeps sending the decisions when a sync stops at a conflict", async () => {
      await using _screen = await readNewFiles();
      await page.getByRole("button", { name: "Keep only here: figures/plot.pdf" }).click();
      await page.getByRole("button", { name: "Send this file: main.aux" }).click();
      await page.getByRole("button", { name: "Send this file: notes.md" }).click();
      // The sync stops at a conflict; its review already carries the decisions: the kept file
      // is left out, the skipped one is selected, the kept-only one is read like a new file.
      client.syncOverleaf.mockResolvedValueOnce({
        ...decision,
        review: review({
          reviewId: "r-conflict",
          conflicts: [
            { key: "k-main", paths: ["main.tex"], allowed: ["mine", "theirs"], chosen: null },
          ],
          additions: [
            { path: "figures/plot.pdf", size: 10, selected: false, skippedBecause: null },
            { path: "main.aux", size: 10, selected: true, skippedBecause: "build-output" },
            {
              path: "data/raw.bin",
              size: 60_000_000,
              selected: false,
              skippedBecause: "too-large",
            },
          ],
          localOnly: [],
        }),
      });
      await page.getByRole("button", { name: "Sync", exact: true }).click();
      await expect.element(page.getByRole("group", { name: "Settle main.tex" })).toBeVisible();
      // Still shown as decided.
      for (const name of [
        "Keep only here: figures/plot.pdf",
        "Send this file: main.aux",
        "Send this file: notes.md",
      ])
        await expect
          .element(page.getByRole("button", { name }))
          .toHaveAttribute("aria-pressed", "true");

      await page
        .getByRole("group", { name: "Settle main.tex" })
        .getByRole("button", { name: "Keep mine" })
        .click();
      await page.getByRole("button", { name: "Sync again" }).click();
      await expect.poll(() => client.syncOverleaf.mock.calls.length).toBe(2);
      // Sync again carries them, so the server doesn't fall back to the defaults.
      expect(client.syncOverleaf.mock.calls[1]![1]).toMatchObject({
        files: { keepOnlyHere: ["figures/plot.pdf"], send: ["main.aux", "notes.md"] },
      });
    });

    it("keeps decisions when the tab closes and opens again, until a sync applies", async () => {
      {
        await using _screen = await readNewFiles();
        await page.getByRole("button", { name: "Keep only here: figures/plot.pdf" }).click();
      }
      // Opening a file replaced the tab; it comes back with the decision.
      await using _again = await render(panel());
      const keep = page.getByRole("button", {
        name: "Keep only here: figures/plot.pdf",
      });
      await expect.element(keep).toHaveAttribute("aria-pressed", "true");
      client.syncOverleaf.mockResolvedValue(applied);
      await page.getByRole("button", { name: "Sync", exact: true }).click();
      await expect.poll(() => client.syncOverleaf.mock.calls.length).toBe(1);
      expect(client.syncOverleaf.mock.calls[0]![1]).toMatchObject({
        files: { keepOnlyHere: ["figures/plot.pdf"] },
      });
      // Applied: the decisions are spent.
      await expect
        .poll(() => readOverleafWorkspace(environmentId, "/work/project").fileDecisions.get("c1"))
        .toBeUndefined();
    });

    it("keeps a new file only here at the next sync", async () => {
      await using _screen = await readNewFiles();
      const keep = page.getByRole("button", {
        name: "Keep only here: figures/plot.pdf",
      });
      await keep.click();
      await expect.element(keep).toHaveAttribute("aria-pressed", "true");
      await expect.element(page.getByText("0 will be sent at the next sync")).toBeVisible();
      // Pressing it again takes the decision back.
      await keep.click();
      await expect.element(page.getByText("1 will be sent", { exact: true })).toBeVisible();
      await keep.click();

      await page.getByRole("button", { name: "Sync", exact: true }).click();
      await expect.poll(() => client.syncOverleaf.mock.calls.length).toBe(1);
      expect(client.syncOverleaf).toHaveBeenCalledWith(environmentId, {
        workspaceRoot: "/work/project",
        connectionId: "c1",
        requestId: "request-1",
        files: { keepOnlyHere: ["figures/plot.pdf"] },
      });
    });

    it("holds decisions while a sync runs", async () => {
      await using _screen = await readNewFiles();
      let finish!: (result: ScientOverleafSyncResult) => void;
      client.syncOverleaf.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const keep = page.getByRole("button", {
        name: "Keep only here: figures/plot.pdf",
      });
      await page.getByRole("button", { name: "Sync", exact: true }).click();
      await expect.element(keep).toBeDisabled();
      await expect
        .element(page.getByRole("button", { name: "Send this file: notes.md" }))
        .toBeDisabled();
      finish({ _tag: "cancelled", stage: "before-apply", retried: false, settled: null });
      await expect.element(keep).toBeEnabled();
    });

    it("sends a skipped file and one kept only here, but never one over Overleaf's limit", async () => {
      await using _screen = await readNewFiles();
      const files = page.getByRole("region", { name: "New files" });
      await expect.element(files.getByText("Build output")).toBeVisible();
      await expect.element(files.getByText("Over Overleaf's 50 MB limit")).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Send this file: data/raw.bin" }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Send this file: main.aux" }).click();
      await page
        .getByRole("region", { name: "Kept only here" })
        .getByRole("button", { name: "Send this file: notes.md" })
        .click();
      await expect.element(page.getByText("2 will be sent at the next sync")).toBeVisible();

      client.syncOverleaf.mockResolvedValue({
        ...applied,
        review: review({ needsDecision: false, conflicts: [], localOnly: ["notes.md"] }),
      });
      await page.getByRole("button", { name: "Sync", exact: true }).click();
      await expect.poll(() => client.syncOverleaf.mock.calls.length).toBe(1);
      expect(client.syncOverleaf.mock.calls[0]![1]).toMatchObject({
        files: { send: ["main.aux", "notes.md"] },
      });
      // Applied: the decisions are spent.
      await expect
        .element(page.getByRole("button", { name: "Send this file: notes.md" }))
        .toHaveAttribute("aria-pressed", "false");
    });
  });

  it("opens a linked copy's file in its normal editor, in a thread on that copy", async () => {
    reset();
    client.listOverleafConnections.mockResolvedValue({
      connections: [{ ...connection, checkoutRoot: "/work/project", linkedHere: false }],
    });
    threads.projects = [{ environmentId, id: "p-main", workspaceRoot: "/work/project" }];
    threads.shellProjectId = "p-main";
    threads.handle.mockReset().mockResolvedValue({ draftId: "draft-1", threadId: "t-linked" });
    recordOverleafSync(environmentId, "c1", decision);
    const onOpenFile = vi.fn();
    await using _screen = await render(
      <OverleafReviewPanel
        environmentId={environmentId}
        cwd="/work/project-wt"
        connectionId="c1"
        threadRef={threadRef}
        onOpenFile={onOpenFile}
      />,
    );
    const linkedThread = { environmentId, threadId: ThreadId.make("t-linked") };
    const openedIn = (ref: typeof threadRef) =>
      (useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]?.surfaces ?? []).flatMap(
        (surface) => (surface.kind === "file" ? [surface.relativePath] : []),
      );
    await page.getByRole("region", { name: "To bring in" }).getByText("refs.bib").click();
    await page.getByRole("button", { name: "intro.tex" }).click();
    await expect.poll(() => openedIn(linkedThread)).toEqual(["paper/refs.bib", "paper/intro.tex"]);
    // The thread is on the linked copy (the project's own folder here)...
    expect(threads.handle).toHaveBeenCalledWith(
      { environmentId, projectId: "p-main" },
      { worktreePath: null, envMode: "local" },
    );
    // ...and nothing opened as this worktree's file of the same name.
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(openedIn(threadRef)).toEqual([]);
  });

  describe("Ask the agent from another worktree", () => {
    function setupWorktree(checkoutRoot: string) {
      reset();
      client.listOverleafConnections.mockResolvedValue({
        connections: [{ ...connection, checkoutRoot, linkedHere: false }],
      });
      client.syncOverleaf.mockResolvedValue({ ...applied, linkedElsewhere: true });
      recordOverleafSync(environmentId, "c1", decision);
      threads.handle.mockReset().mockResolvedValue({ draftId: "draft-1", threadId: "t-new" });
      const setPrompt = vi.fn();
      const getState = useComposerDraftStore.getState;
      const spy = vi
        .spyOn(useComposerDraftStore, "getState")
        .mockImplementation(() => ({ ...getState(), setPrompt }));
      return { setPrompt, [Symbol.dispose]: () => spy.mockRestore() };
    }

    async function askAboutMain(composer: ReturnType<typeof composerStub>) {
      await using _screen = await render(
        <ComposerHandleContext value={composer.ref}>
          <OverleafReviewPanel
            environmentId={environmentId}
            cwd="/work/project-wt"
            connectionId="c1"
            threadRef={threadRef}
            onOpenFile={() => {}}
          />
        </ComposerHandleContext>,
      );
      for (const [path, choice] of [
        ["main.tex", "Ask the agent"],
        ["intro.tex", "Keep mine"],
        ["old.tex", "Keep mine"],
      ] as const) {
        await page
          .getByRole("group", { name: `Settle ${path}` })
          .getByRole("button", { name: choice })
          .click();
      }
      await page.getByRole("button", { name: "Sync again" }).click();
      await expect.poll(() => threads.handle.mock.calls.length).toBe(1);
    }

    it("starts a thread in the project's own folder when that is the linked copy", async () => {
      using worktree = setupWorktree("/work/project");
      threads.projects = [{ environmentId, id: "p-main", workspaceRoot: "/work/project" }];
      threads.shellProjectId = "p-main";
      const composer = composerStub();
      await askAboutMain(composer);

      expect(threads.handle).toHaveBeenCalledExactlyOnceWith(
        { environmentId, projectId: "p-main" },
        { worktreePath: null, envMode: "local" },
      );
      await expect.poll(() => worktree.setPrompt.mock.calls.length).toBe(1);
      const [draftId, message] = worktree.setPrompt.mock.calls[0] as [string, string];
      expect(draftId).toBe("draft-1");
      expect(message).toContain("- paper/main.tex");
      // This thread's composer is left alone: its agent can't see the linked copy's files.
      expect(composer.insertTextAtEnd).not.toHaveBeenCalled();
    });

    it("starts a thread in the linked worktree when the link is in another worktree", async () => {
      using worktree = setupWorktree("/work/paper-wt");
      threads.projects = [{ environmentId, id: "p-main", workspaceRoot: "/work/project" }];
      threads.shellProjectId = "p-main";
      await askAboutMain(composerStub());

      expect(threads.handle).toHaveBeenCalledExactlyOnceWith(
        { environmentId, projectId: "p-main" },
        { worktreePath: "/work/paper-wt", envMode: "worktree" },
      );
      await expect.poll(() => worktree.setPrompt.mock.calls.length).toBe(1);
    });
  });
});
