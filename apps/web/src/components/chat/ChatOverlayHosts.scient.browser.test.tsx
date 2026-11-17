import { MessageId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import "../../index.css";

import {
  ScientRevertDialogDiagnostics,
  describeUnrestorableRevertFiles,
} from "../../scient/chat/ScientRevertDialogDiagnostics";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import type { TurnDiffSummary } from "../../types";
import { openRevertConfirm, RevertConfirmHost, settleRevertConfirm } from "./ChatOverlayHosts";
import { retainThreadOverlaysForThread } from "./threadOverlayRetention";

type Checkpoints = OrchestrationV2ThreadProjection["checkpoints"];

const messageId = MessageId.make("message-2");
const checkpointAtTurn2 = (status: "ready" | "error") =>
  [{ appRunOrdinal: 2, ordinalWithinScope: 1, status }] as unknown as Checkpoints;

function Host(props: {
  readonly threadKey?: string;
  readonly checkpoints?: Checkpoints;
  readonly worktreePath?: string | null;
  readonly reverting?: boolean;
  readonly fileHistoryIssue?: TurnDiffSummary | null;
  readonly onConfirm: (turnCount: number, messageId: MessageId, restoreFiles: boolean) => void;
}) {
  return (
    <AppAtomRegistryProvider>
      <RevertConfirmHost
        threadKey={props.threadKey ?? "thread-a"}
        checkpoints={props.checkpoints ?? checkpointAtTurn2("ready")}
        worktreePath={props.worktreePath === undefined ? "/worktree" : props.worktreePath}
        onConfirm={props.onConfirm}
        reverting={props.reverting ?? false}
        describeUnrestorableFiles={describeUnrestorableRevertFiles}
        renderDetails={(error) => (
          <ScientRevertDialogDiagnostics
            fileHistoryIssue={props.fileHistoryIssue ?? null}
            error={error}
          />
        )}
      />
    </AppAtomRegistryProvider>
  );
}

// The overlay atom outlives each render; every test starts and ends with no dialog open.
function noOpenOverlays(): Disposable {
  retainThreadOverlaysForThread(null);
  return { [Symbol.dispose]: () => retainThreadOverlaysForThread(null) };
}

const dialog = () => page.getByRole("alertdialog");
const dialogText = () => document.querySelector('[role="alertdialog"]')?.textContent ?? "";
const action = (name: string) => page.getByRole("button", { name, exact: true });

describe("the revert dialog with Scient's explanations", () => {
  it("stays open with its actions disabled while reverting, then closes on success", async () => {
    using _overlays = noOpenOverlays();
    const onConfirm = vi.fn();
    await using screen = await render(<Host onConfirm={onConfirm} />, { router: false });
    await act(() => openRevertConfirm("thread-a", { turnCount: 2, messageId }));
    await expect.element(action("Revert files too")).toBeEnabled();
    await userEvent.click(action("Revert and keep changes"));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(2, messageId, false);
    await screen.rerender(<Host onConfirm={onConfirm} reverting />);
    await expect.element(dialog()).toBeVisible();
    for (const name of ["Cancel", "Revert files too", "Revert and keep changes"]) {
      await expect.element(action(name)).toBeDisabled();
    }
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog()).toBeVisible();

    await screen.rerender(<Host onConfirm={onConfirm} />);
    await act(() => expect(settleRevertConfirm("thread-a", null)).toBe(true));
    await expect.element(dialog()).not.toBeInTheDocument();
  });

  it("shows a failed revert's error in the dialog and lets it be retried", async () => {
    using _overlays = noOpenOverlays();
    const onConfirm = vi.fn();
    await using _screen = await render(<Host onConfirm={onConfirm} />, { router: false });
    await act(() => openRevertConfirm("thread-a", { turnCount: 2, messageId }));
    await act(() => settleRevertConfirm("thread-a", "checkpoint ref missing"));
    await vi.waitFor(() => expect(dialogText()).toContain("Could not rewind this conversation."));
    expect(document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toContain(
      "checkpoint ref missing",
    );
    await userEvent.click(action("Revert files too"));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(2, messageId, true);
  });

  it.each([
    {
      case: "no snapshot",
      checkpoints: checkpointAtTurn2("error"),
      worktreePath: "/worktree",
      reason: "Scient could not save a snapshot of them from before this message.",
    },
    {
      case: "outside the worktree",
      checkpoints: checkpointAtTurn2("ready"),
      worktreePath: null,
      reason: "Your files stay as they are.",
    },
  ])("explains files that cannot be restored ($case) and offers only Rewind chat", async (row) => {
    using _overlays = noOpenOverlays();
    const onConfirm = vi.fn();
    await using _screen = await render(
      <Host onConfirm={onConfirm} checkpoints={row.checkpoints} worktreePath={row.worktreePath} />,
      { router: false },
    );
    await act(() => openRevertConfirm("thread-a", { turnCount: 2, messageId }));
    await expect.element(action("Rewind chat")).toBeVisible();
    expect(dialogText()).toContain(row.reason);
    expect(dialogText()).not.toContain("Revert files too");
    await userEvent.click(action("Rewind chat"));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(2, messageId, false);
  });

  it("keeps the earlier-snapshot-failure note", async () => {
    using _overlays = noOpenOverlays();
    const issue = {
      runId: "run-1",
      scopeId: "scope-1",
      checkpointId: "checkpoint-1",
      status: "error",
    } as unknown as TurnDiffSummary;
    await using _screen = await render(<Host onConfirm={vi.fn()} fileHistoryIssue={issue} />, {
      router: false,
    });
    await act(() => openRevertConfirm("thread-a", { turnCount: 2, messageId }));
    await expect.element(page.getByText("File history diagnostics")).toBeInTheDocument();
  });

  it("never shows or settles one thread's revert on another thread", async () => {
    using _overlays = noOpenOverlays();
    const onConfirm = vi.fn();
    await using _screen = await render(<Host onConfirm={onConfirm} threadKey="thread-b" />, {
      router: false,
    });
    await act(() => openRevertConfirm("thread-a", { turnCount: 2, messageId }));
    await expect.element(dialog()).not.toBeInTheDocument();
    // Leaving thread A's route drops its dialog, so its late result reports elsewhere.
    await act(() => retainThreadOverlaysForThread("thread-b"));
    expect(settleRevertConfirm("thread-a", "late failure")).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps T3's close-on-confirm and disabled file restore without Scient's props", async () => {
    using _overlays = noOpenOverlays();
    const onConfirm = vi.fn();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <RevertConfirmHost
          threadKey="thread-a"
          checkpoints={checkpointAtTurn2("error")}
          worktreePath="/worktree"
          onConfirm={onConfirm}
        />
      </AppAtomRegistryProvider>,
      { router: false },
    );
    await act(() => openRevertConfirm("thread-a", { turnCount: 2, messageId }));
    await expect.element(action("Revert files too")).toBeDisabled();
    await userEvent.click(action("Revert and keep changes"));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(2, messageId, false);
    await expect.element(dialog()).not.toBeInTheDocument();
  });
});
