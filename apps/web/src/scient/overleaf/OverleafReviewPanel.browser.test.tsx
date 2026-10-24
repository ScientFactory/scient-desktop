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
  listOverleafConnections: vi.fn(),
  readOverleafStatus: vi.fn(),
  listOverleafKeptCopies: vi.fn(),
  restoreOverleafKeptCopy: vi.fn(),
  disconnectOverleaf: vi.fn(),
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

const { useComposerDraftStore } = await import("~/composerDraftStore");
const { OverleafReviewPanel } = await import("./OverleafReviewPanel");
const { recordOverleafSync, resetOverleafStoreForTests } = await import("./overleafStore");

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
    collisions: [],
    selectedAdditions: [],
    ...overrides,
  };
}

const decision: ScientOverleafSyncResult = {
  _tag: "needs-decision",
  review: review(),
  activity: [],
  linkedElsewhere: false,
};

const applied: ScientOverleafSyncResult = {
  _tag: "synced",
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
  it("offers four choices per file conflict and two for a group, then syncs again with them", async () => {
    reset();
    recordOverleafSync(environmentId, "/work/project", "c1", decision);
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
      review: review({ needsDecision: false, conflicts: [] }),
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
    await incoming.getByText("refs.bib").click();
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("paper/refs.bib");
    expect(client.previewOverleaf).toHaveBeenCalledExactlyOnceWith(environmentId, {
      workspaceRoot: "/work/project",
      connectionId: "c1",
    });
  });

  describe("Ask the agent from another worktree", () => {
    function setupWorktree(checkoutRoot: string) {
      reset();
      client.listOverleafConnections.mockResolvedValue({
        connections: [{ ...connection, checkoutRoot, linkedHere: false }],
      });
      client.syncOverleaf.mockResolvedValue({ ...applied, linkedElsewhere: true });
      recordOverleafSync(environmentId, "/work/project-wt", "c1", decision);
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
