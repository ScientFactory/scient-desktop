import { render } from "../../../test/render";
import "../../index.css";

import { Atom, AsyncResult } from "effect/reactivity";
import { revealInFileExplorerLabelForKind } from "~/components/preview/fileExplorerLabel";
import { EnvironmentId, type ScientOverleafKeptCopies } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

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
  cancelOverleafSync: vi.fn(),
  listOverleafUndoableSends: vi.fn(),
  undoOverleafSend: vi.fn(),
}));
vi.mock("./client", () => ({ ...client, overleafRequestId: () => "request-1" }));
// Opening a file on the linked copy goes through the app's own new-thread path.
const threads = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("~/hooks/useHandleNewThread", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useHandleNewThread")>()),
  useNewThreadHandler: () => threads.handle,
}));
vi.mock("~/state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/entities")>()),
  readProjects: () => [{ environmentId: "local", id: "p-main", workspaceRoot: "/work/project" }],
  readThreadShell: () => null,
}));

const reveal = vi.hoisted(() => ({ config: vi.fn(), open: vi.fn() }));
vi.mock("~/state/server", async (original) => {
  const actual = await original<typeof import("~/state/server")>();
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: reveal.config },
  };
});
vi.mock("~/state/use-atom-command", async () => {
  const { shellEnvironment } = await import("~/state/shell");
  return {
    useAtomCommand: (command: unknown) => {
      if (command !== shellEnvironment.openInEditor) throw new Error("Unexpected command");
      return reveal.open;
    },
  };
});

const { OverleafKeptCopies } = await import("./OverleafKeptCopies");
const { resetOverleafStoreForTests } = await import("./overleafStore");
const { useRightPanelStore } = await import("~/rightPanelStore");
const { scopedThreadKey } = await import("@t3tools/client-runtime/environment");

const environmentId = EnvironmentId.make("local");

const link = (linkedHere: boolean) => ({
  connectionId: "c1",
  checkoutRoot: "/work/project",
  folder: "paper",
  projectId: "0123456789abcdef01234567",
  branch: "master" as const,
  state: "active" as const,
  completedSyncCount: 1,
  createdAt: "2026-10-24T10:00:00.000Z",
  updatedAt: "2026-10-24T10:00:00.000Z",
  linkedHere,
});

const keptCopy = {
  applyId: "a1",
  kept: "a1/retained/main.tex",
  path: "/private/kept/a1/retained/main.tex",
  relativePath: "main.tex",
  state: "kept",
  retainedAt: "2026-10-24T11:00:00.000Z",
  revision: "r1",
  keptRevision: "k1",
  currentRevision: "c1",
  unread: false,
} satisfies ScientOverleafKeptCopies["copies"][number];

function reset(linkedHere: boolean) {
  resetOverleafStoreForTests();
  reveal.config.mockReturnValue(Atom.make(null));
  reveal.open.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  for (const mock of Object.values(client)) mock.mockReset();
  client.listOverleafConnections.mockResolvedValue({ connections: [link(linkedHere)] });
  client.readOverleafStatus.mockRejectedValue(new Error("not needed"));
  client.listOverleafKeptCopies.mockResolvedValue({
    copies: [keptCopy],
  });
  threads.handle.mockReset().mockResolvedValue({ draftId: "draft-1", threadId: "t-linked" });
}

const copies = (cwd: string) => (
  <OverleafKeptCopies environmentId={environmentId} cwd={cwd} relativePath="paper/main.tex" />
);

describe("OverleafKeptCopies", () => {
  it("lists the linked copy's kept copies of the file, with Restore", async () => {
    reset(true);
    client.restoreOverleafKeptCopy.mockResolvedValue({ _tag: "restored", outcome: "complete" });
    await using _screen = await render(copies("/work/project"));
    await page.getByRole("button", { name: "Restore" }).click();
    await expect.element(page.getByText("Restored. The next sync sends it.")).toBeVisible();
    expect(client.restoreOverleafKeptCopy).toHaveBeenCalledWith(
      environmentId,
      expect.objectContaining({ workspaceRoot: "/work/project", kept: "a1/retained/main.tex" }),
    );
  });

  it("reveals the listed path only in an environment that can reveal, for readable copies", async () => {
    const label = revealInFileExplorerLabelForKind("file-explorer");
    for (const capability of [
      { shellRevealInFileManager: false, availableEditors: ["file-manager"], offered: false },
      { shellRevealInFileManager: true, availableEditors: ["file-manager"], offered: true },
    ]) {
      reset(true);
      reveal.config.mockReturnValue(
        Atom.make({
          ...capability,
          shellRevealInFileManagerKind: "file-explorer",
          environment: { platform: { os: "linux" } },
        }),
      );
      const copy = keptCopy;
      client.listOverleafKeptCopies.mockResolvedValue({
        copies: [
          copy,
          { ...copy, kept: "unread", unread: true },
          { ...copy, kept: "vanished", keptRevision: null },
        ],
      });
      await using screen = await render(copies("/work/project"));
      await expect.element(screen.getByRole("button", { name: "Restore" }).first()).toBeVisible();
      const buttons = screen.getByRole("button", { name: label });
      if (!capability.offered) {
        await expect.element(buttons).not.toBeInTheDocument();
        expect(reveal.open).not.toHaveBeenCalled();
        continue;
      }
      await expect.element(buttons.nth(1)).toBeDisabled();
      await expect.element(buttons.nth(2)).toBeDisabled();
      await buttons.first().click();
      expect(reveal.open).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: { cwd: copy.path, editor: "file-manager", reveal: true },
      });
    }
  });

  it("says when a restore wrote nothing, or needs attention, instead of restored", async () => {
    reset(true);
    client.restoreOverleafKeptCopy.mockResolvedValueOnce({ _tag: "restored", outcome: "replan" });
    await using _screen = await render(copies("/work/project"));
    await page.getByRole("button", { name: "Restore" }).click();
    await expect
      .element(
        page.getByText("The file changed while restoring, so nothing was written. Try again."),
      )
      .toBeVisible();
    await expect
      .element(page.getByText("Restored. The next sync sends it."))
      .not.toBeInTheDocument();
    client.restoreOverleafKeptCopy.mockResolvedValueOnce({
      _tag: "restored",
      outcome: "attention",
    });
    await page.getByRole("button", { name: "Restore" }).click();
    await expect
      .element(page.getByText(/^The restore needs attention: it may have stopped partway/u))
      .toBeVisible();
  });

  it("in another worktree, offers the main copy's file instead of restoring into it", async () => {
    reset(false);
    await using _screen = await render(copies("/work/project-wt"));
    await expect.element(page.getByText("Kept copies are in the main copy.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    expect(client.listOverleafKeptCopies).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Open there" }).click();
    const linkedThread = { environmentId, threadId: "t-linked" } as never;
    await expect
      .poll(() =>
        (
          useRightPanelStore.getState().byThreadKey[scopedThreadKey(linkedThread)]?.surfaces ?? []
        ).flatMap((surface) => (surface.kind === "file" ? [surface.relativePath] : [])),
      )
      .toEqual(["paper/main.tex"]);
    expect(threads.handle).toHaveBeenCalledWith(
      { environmentId, projectId: "p-main" },
      { worktreePath: null, envMode: "local" },
    );
    expect(client.restoreOverleafKeptCopy).not.toHaveBeenCalled();
  });
});
