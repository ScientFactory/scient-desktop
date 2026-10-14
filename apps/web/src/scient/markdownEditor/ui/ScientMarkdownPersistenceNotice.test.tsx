// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MarkdownPersistenceCoordinator } from "@scientfactory/scient-markdown";
import type {
  DocumentPersistenceCurrentReview,
  DocumentSaveIntent,
} from "@scientfactory/scient-document";
import { EnvironmentId, ProjectWriteFileError } from "@t3tools/contracts";
import type { MarkdownPersistenceLease } from "../persistence/markdownPersistenceRegistry";
import { ScientMarkdownPersistenceNotice } from "./ScientMarkdownPersistenceNotice";
import { classifyMarkdownPersistenceFailure } from "../persistence/markdownPersistenceTransport";
import { MarkdownPersistenceRegistry } from "../persistence/markdownPersistenceRegistry";
import {
  markdownViewTransition,
  resolveMarkdownRenderedState,
} from "../../fileOpening/fileOpeningPolicy";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Markdown persistence feedback", () => {
  const roots: ReturnType<typeof createRoot>[] = [];
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
  });
  afterEach(async () => {
    for (const root of roots.splice(0)) await act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });
  function mount(
    coordinator: MarkdownPersistenceCoordinator,
    extra: Partial<Parameters<typeof ScientMarkdownPersistenceNotice>[0]> = {},
  ) {
    const persistence: MarkdownPersistenceLease = {
      target: {
        environmentId: EnvironmentId.make("test"),
        cwd: "/synthetic",
        relativePath: "notes.md",
      },
      documentId: "fixture-document",
      owner: undefined,
      beginMove: () => null,
      getSnapshot: coordinator.getSnapshot,
      getPendingInput: () => null,
      getRenameIntent: () => null,
      canEditPendingInput: () => true,
      claimPendingInput: () => true,
      releasePendingInputClaim: () => {},
      retainPendingInput: () => true,
      subscribe: coordinator.subscribe,
      change: (source, version) => coordinator.change(source, version),
      applyEdit: coordinator.applyEdit.bind(coordinator),
      noteFreshnessHint: () => coordinator.noteFreshnessHint(),
      flushNow: () => coordinator.flushNow(),
      recreateMissingCurrent: () => coordinator.recreateMissingCurrent(),
      retry: () => coordinator.retry(),
      refresh: () => coordinator.refresh(),
      resolveRetainedAttention: (recoveryId, currentRevision) =>
        coordinator.resolveRetainedAttention(recoveryId, currentRevision),
      reviewRetainedCurrent: (recoveryId) => coordinator.reviewRetainedCurrent(recoveryId),
      reviewUnchangedRefusal: (currentRevision) =>
        coordinator.reviewUnchangedRefusal(currentRevision),
      noteMutationFailure: (error) => coordinator.noteMutationFailure(error),
      resolveWithLocal: (revision) => coordinator.resolveWithLocal(revision),
      resolveWithDisk: () => coordinator.resolveWithDisk(),
      restoreRecovery: () => coordinator.restoreRecovery(),
      holdForRename: () => coordinator.holdForRename(),
      registerExternalProjection: () => () => {},
      resumeExternalUpdates: () => coordinator.resumeExternalUpdates(),
      release: () => {},
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() =>
      root.render(<ScientMarkdownPersistenceNotice persistence={persistence} {...extra} />),
    );
    return host;
  }

  it("shows reviewed absence as unsaved historical source and creates only after a distinct user action", async () => {
    const attention = {
      recoveryId: "notice-absent",
      mutationId: "old",
      retainedPaths: ["/retained/A"],
      message: "Review.",
    };
    let current: DocumentPersistenceCurrentReview = {
      missing: true,
      revision: null,
      publicationAttention: attention,
    };
    const write = vi.fn(async (intent: DocumentSaveIntent) => {
      if (!intent.createOnly || !current.missing) throw "conflict";
      current = { source: intent.source, revision: "created" };
      return { revision: "created" };
    });
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "historical",
      initialPublicationAttention: attention,
      write,
      classifyFailure: () => "terminal",
      read: async () => {
        if (current.missing) throw "not_found";
        return current;
      },
      readForReview: async () => current,
      resolve: async () => {
        current = { missing: true, revision: null };
        return { revision: null };
      },
    });
    const host = mount(coordinator);
    await act(async () => click(host, "Show file on disk"));
    expect(host.querySelector("[aria-label='Reviewed current disk version'] pre")).toBeNull();
    await act(async () => click(host, "Continue from this version"));
    expect(coordinator.getSnapshot()).toMatchObject({
      currentMissing: true,
      pending: true,
      draftSource: "A",
      baselineSource: "A",
    });
    expect(write).not.toHaveBeenCalled();
    expect(
      [...host.querySelectorAll("button")].some((button) => button.textContent === "Save it again"),
    ).toBe(true);
    await act(async () => click(host, "Save it again"));
    expect(current).toEqual({ source: "A", revision: "created" });
    expect(coordinator.getSnapshot()).toMatchObject({ currentMissing: false, pending: false });
  });
  function click(host: HTMLElement, text: string) {
    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === text,
    );
    expect(button).toBeDefined();
    button!.click();
  }

  it("returns to Rich past an outstanding source-line reveal without publishing pending input", () => {
    const write = vi.fn(async () => ({ revision: "r1" }));
    const registry = new MarkdownPersistenceRegistry({
      createTransport: () => ({
        write,
        read: async () => ({ source: "Saved source", revision: "r0" }),
        classifyFailure: () => "terminal",
        subscribe: () => () => {},
        project: () => {},
      }),
    });
    const target = {
      environmentId: EnvironmentId.make("return-rich"),
      cwd: "/synthetic",
      relativePath: "paper.md",
    };
    const lease = registry.acquire(target, {
      relativePath: "paper.md",
      contents: "Saved source",
      revision: "r0",
      byteLength: 12,
      truncated: false,
    })!;
    const pending = { message: "Pending input", payload: { text: "Keep this input" } };
    lease.retainPendingInput(pending);
    const revealRequestId = 7;
    function PanelViewState() {
      const [state, setState] = useState(
        markdownViewTransition(false, target.relativePath, revealRequestId - 1),
      );
      // This is the panel's actual gate for a non-null source-line reveal.
      const revealHandled =
        state.handledReveal?.path === target.relativePath &&
        state.handledReveal.requestId === revealRequestId;
      const citationRevealActive = state.dismissedCitationReveal !== revealRequestId;
      const rich = resolveMarkdownRenderedState(
        state.preferred,
        citationRevealActive,
        revealHandled,
      );
      return (
        <>
          <ScientMarkdownPersistenceNotice
            persistence={lease}
            onReturnToRich={() =>
              setState(markdownViewTransition(true, target.relativePath, revealRequestId))
            }
          />
          <div data-view>{rich ? "Rich editor" : "Source editor"}</div>
        </>
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(<PanelViewState />));
    expect(host.querySelector("[data-view]")?.textContent).toBe("Source editor");
    act(() => click(host, "Return to Rich"));
    expect(host.querySelector("[data-view]")?.textContent).toBe("Rich editor");
    expect(lease.getPendingInput()).toBe(pending);
    expect(lease.getSnapshot().draftSource).toBe("Saved source");
    expect(write).not.toHaveBeenCalled();
    lease.release();
  });
  it("reviews retained evidence without retrying, clearing the blocked mutation, or dropping the draft", async () => {
    const error = {
      failure: "recovery_required",
      recoveryId: "recovery-synthetic",
      retainedPaths: ["/synthetic-retained/old.md"],
    };
    const read = vi.fn(async () => ({ source: "Current disk", revision: "rCurrent" }));
    const write = vi.fn(async () => ({ revision: "rWritten" }));
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "Initial",
      revision: "rInitial",
      read,
      write,
      classifyFailure: () => "recovery_required",
    });
    coordinator.change("Local draft", coordinator.getSnapshot().editVersion);
    coordinator.noteMutationFailure(error);
    const open = vi.fn();
    const host = mount(coordinator, { onOpenFile: open });
    expect(
      [...host.querySelectorAll("button")].some((button) => button.textContent === "Try again"),
    ).toBe(false);
    await act(async () => click(host, "Open earlier version"));
    expect(open).toHaveBeenCalledWith("/synthetic-retained/old.md");
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({
      attention: "recovery_required",
      baselineRevision: "rInitial",
      draftSource: "Local draft",
    });
  });

  it("keeps mutation-only unknown outcomes blocked while retained versions remain readable", async () => {
    const read = vi.fn(async () => ({ source: "Disk", revision: "rDisk" }));
    const resolve = vi.fn(async () => ({ revision: "rDisk" }));
    const write = vi.fn(async () => ({ revision: "rWritten" }));
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "Baseline",
      revision: "rInitial",
      draftSource: "Local draft",
      read,
      resolve,
      write,
      classifyFailure: () => "outcome_unknown",
    });
    coordinator.noteMutationFailure(
      {
        failure: "outcome_unknown",
        retainedPaths: ["/synthetic-retained/unknown.md"],
      },
      "display-only-mutation",
    );
    const open = vi.fn();
    const host = mount(coordinator, { onOpenFile: open });
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Open earlier version",
      "Details",
    ]);
    await act(async () => click(host, "Open earlier version"));
    expect(open).toHaveBeenCalledExactlyOnceWith("/synthetic-retained/unknown.md");
    await act(async () => {
      await coordinator.flushNow();
    });
    expect(read).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({
      attention: "outcome_unknown",
      attentionMutationId: "display-only-mutation",
      publicationAttention: null,
      publicationOutcome: null,
      baselineRevision: "rInitial",
      baselineSource: "Baseline",
      draftSource: "Local draft",
      pending: true,
    });
    expect(host.querySelector("[aria-label='Reviewed current disk version']")).toBeNull();
  });

  it("accepts only a completed actual-ID review and preserves the local draft without publishing it", async () => {
    const attention = {
      recoveryId: "actual-recovery",
      mutationId: "display-mutation",
      retainedPaths: [],
      message: "Review.",
    };
    let disk = {
      source: "Current disk bytes",
      revision: "rCurrent",
      publicationAttention: attention as typeof attention | null,
    };
    const reviewStarted = Promise.withResolvers<void>();
    const releaseReview = Promise.withResolvers<void>();
    let reads = 0;
    const read = async () => {
      if (++reads === 1) {
        reviewStarted.resolve();
        await releaseReview.promise;
      }
      return disk;
    };
    const resolve = vi.fn(async () => {
      disk = { ...disk, publicationAttention: null };
      return { revision: disk.revision };
    });
    const write = vi.fn(async () => ({ revision: "unused" }));
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "Baseline",
      revision: "rInitial",
      draftSource: "Local draft",
      initialPublicationAttention: attention,
      read,
      resolve,
      write,
      classifyFailure: () => "terminal",
    });
    const host = mount(coordinator);
    const acceptance = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Continue from this version",
    )!;
    expect(acceptance.disabled).toBe(true);
    await act(async () => {
      click(host, "Show file on disk");
      await reviewStarted.promise;
    });
    expect(acceptance.disabled).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({
      attention: "recovery_required",
      baselineRevision: "rInitial",
      draftSource: "Local draft",
    });
    await act(async () => releaseReview.resolve());
    expect(
      host.querySelector("[aria-label='Reviewed current disk version'] pre")?.textContent,
    ).toBe("Current disk bytes");
    expect(acceptance.disabled).toBe(false);
    expect(coordinator.getSnapshot().attention).toBe("recovery_required");
    await act(async () => acceptance.click());
    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      recoveryId: "actual-recovery",
      currentRevision: "rCurrent",
    });
    expect(write).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({
      attention: null,
      publicationAttention: null,
      baselineRevision: "rCurrent",
      baselineSource: "Current disk bytes",
      draftSource: "Local draft",
      pending: true,
    });
  });

  it("acknowledges known unchanged refusals through ordered review without a recovery request", async () => {
    const read = vi.fn(async () => ({ source: "Disk", revision: "rDisk" }));
    const resolve = vi.fn(async () => ({ revision: "rDisk" }));
    const write = vi.fn(async () => ({ revision: "unused" }));
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "Baseline",
      revision: "rInitial",
      draftSource: "Local draft",
      read,
      resolve,
      write,
      classifyFailure: () => "target_changed",
      describeOutcome: () => "unchanged",
    });
    coordinator.noteMutationFailure({ failure: "target_changed" }, "display-only-mutation");
    const host = mount(coordinator);
    await act(async () => click(host, "Continue from this version"));
    expect(coordinator.getSnapshot().attention).toBe("target_changed");
    expect(read).not.toHaveBeenCalled();
    await act(async () => click(host, "Show file on disk"));
    expect(
      host.querySelector("[aria-label='Reviewed current disk version'] pre")?.textContent,
    ).toBe("Disk");
    expect(coordinator.getSnapshot()).toMatchObject({
      attention: "target_changed",
      baselineRevision: "rInitial",
      draftSource: "Local draft",
    });
    await act(async () => click(host, "Continue from this version"));
    expect(resolve).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({
      attention: null,
      baselineRevision: "rDisk",
      baselineSource: "Disk",
      draftSource: "Local draft",
      pending: true,
    });
  });

  it.each([
    "target_changed",
    "mutation_unavailable",
    "mutation_intent_conflict",
    "outcome_unknown",
  ] as const)("does not offer retry or disk replacement for %s", (attention) => {
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "Local source",
      revision: "rInitial",
      read: vi.fn(async () => ({ source: "Disk", revision: "rDisk" })),
      write: vi.fn(async () => ({ revision: "rWritten" })),
      classifyFailure: () => attention,
    });
    coordinator.noteMutationFailure({ failure: attention });
    const host = mount(coordinator);
    expect(host.querySelectorAll("button")).toHaveLength(0);
    expect(coordinator.getSnapshot().draftSource).toBe("Local source");
    expect(coordinator.getSnapshot().attention).toBe(attention);
  });

  it("keeps both quick and slow routine saves silent, including screen readers", async () => {
    const write = deferred<{ revision: string }>();
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "rA",
      write: () => write.promise,
      read: async () => ({ source: "B", revision: "rB" }),
      classifyFailure: () => "terminal",
    });
    const host = mount(coordinator);
    await act(async () => {
      coordinator.change("B");
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(host.textContent).toBe("");
    expect(host.querySelector("[role=region]")).toBeNull();
    await act(async () => {
      write.resolve({ revision: "rB" });
    });
    expect(host.textContent).toBe("");
  });

  it("adds nothing when a failure carries no reason", async () => {
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "rA",
      write: async () => {
        throw new Error("protocol failure");
      },
      read: async () => ({ source: "A", revision: "rA" }),
      classifyFailure: () => "terminal",
    });
    const host = mount(coordinator);
    await act(async () => {
      coordinator.change("B");
      await coordinator.flushNow();
    });
    expect(host.querySelector("[role=region]")).not.toBeNull();
    expect(host.querySelector("[data-persistence-reason]")).toBeNull();
  });

  it("shows no conflict until ordered verification and keeps actions outside the live region", async () => {
    const read = deferred<{ source: string; revision: string }>();
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "rA",
      write: async () => {
        throw new Error("cas");
      },
      read: () => read.promise,
      classifyFailure: () => "conflict",
    });
    const host = mount(coordinator);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await act(async () => {
      coordinator.change("B");
      void coordinator.flushNow();
    });
    expect(host.querySelector("[role=region]")).toBeNull();
    await act(async () => {
      read.resolve({ source: "External", revision: "rX" });
    });
    expect(host.querySelectorAll("[role=region]")).toHaveLength(1);
    expect(host.querySelector("[role=status]")?.textContent).toBe(
      "This file changed on disk while you were editing",
    );
    expect(host.querySelector("[role=status] button")).toBeNull();
    expect(document.activeElement).toBe(input);
    await act(() => coordinator.change("C"));
    expect(host.querySelector("[role=status]")?.textContent).toBe(
      "This file changed on disk while you were editing",
    );
  });

  it("confirms disk replacement and retains the previous local draft for recovery", async () => {
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "rA",
      write: async () => {
        throw new Error("cas");
      },
      read: async () => ({ source: "External", revision: "rX" }),
      classifyFailure: () => "conflict",
    });
    const host = mount(coordinator);
    await act(async () => {
      coordinator.change("B");
      await coordinator.flushNow();
    });
    await act(() => click(host, "Use disk version…"));
    expect(coordinator.getSnapshot().draftSource).toBe("B");
    await act(async () => click(host, "Use disk version"));
    expect(coordinator.getSnapshot().draftSource).toBe("External");
    expect(coordinator.getSnapshot().recoverySource).toBe("B");
    expect(host.querySelector("[role=region]")).toBeNull();
    await act(() => click(host, "Restore"));
    expect(coordinator.getSnapshot().draftSource).toBe("B");
  });

  it("does not claim unsaved edits when only a clean file refresh failed", async () => {
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "rA",
      write: async () => ({ revision: "unused" }),
      read: async () => {
        throw new Error("permission denied");
      },
      classifyFailure: () => "terminal",
    });
    const host = mount(coordinator);
    await act(async () => coordinator.noteFreshnessHint());
    expect(coordinator.getSnapshot().pending).toBe(false);
    expect(host.textContent).toContain("This file couldn’t be refreshed");
    expect(host.textContent).not.toContain("Couldn’t save");
    await act(() => coordinator.change("B"));
    expect(host.textContent).toContain("Couldn’t save");
    expect(host.querySelector("[role=status]")?.textContent).toBe("Couldn’t save");
  });

  it("explains a moved file and offers the same-name files as other documents", async () => {
    const onOpenFile = vi.fn();
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "rA",
      write: async () => ({ revision: "unused" }),
      read: async () => {
        throw new Error("missing");
      },
      classifyFailure: () => "terminal",
    });
    const host = mount(coordinator, {
      refreshCopy: {
        title: "This file is no longer at this location",
        description:
          "It may have been moved, renamed, or deleted. The last confirmed version is still open.",
      },
      missingFileChoices: ["archive/notes.md", "drafts/notes.md", "old/notes.md"],
      onOpenFile,
    });
    await act(async () => coordinator.noteFreshnessHint());

    expect(host.textContent).toContain("This file is no longer at this location");
    expect(host.textContent).toContain("The last confirmed version is still open.");
    expect(host.textContent).not.toContain("couldn’t be refreshed");
    // A choice opens another document; the open one keeps its draft.
    await act(() => click(host, "archive/notes.md"));
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("archive/notes.md");
    expect(coordinator.getSnapshot().draftSource).toBe("A");
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Try again",
      "archive/notes.md",
      "drafts/notes.md",
    ]);

    // Unsaved edits are a different episode and keep their own explanation.
    await act(() => coordinator.change("B"));
    expect(host.textContent).toContain("Couldn’t save");
    expect(host.textContent).not.toContain("archive/notes.md");
  });

  it("returns focus to this source editor when resolving removes the focused action", async () => {
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "rA",
      write: async () => {
        throw new Error("cas");
      },
      read: async () => ({ source: "External", revision: "rX" }),
      classifyFailure: () => "conflict",
    });
    const host = mount(coordinator);
    await act(async () => {
      coordinator.change("B");
      await coordinator.flushNow();
    });
    const file = document.createElement("diffs-container");
    const shadow = file.attachShadow({ mode: "open" });
    const source = document.createElement("div");
    source.setAttribute("contenteditable", "true");
    source.setAttribute("data-content", "");
    source.tabIndex = 0;
    shadow.append(source);
    host.append(file);
    await act(() => click(host, "Use disk version…"));
    const action = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Use disk version",
    )!;
    action.focus();
    await act(async () => action.click());
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(shadow.activeElement).toBe(source);
  });

  it("retries a save the server proved unwritten, then offers Try again with the reason", async () => {
    let attempts = 0;
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "rA",
      write: async () => {
        attempts++;
        throw new ProjectWriteFileError({
          cwd: "/synthetic",
          relativePath: "notes.md",
          failure: "operation_failed",
          osErrorCode: "ENOSPC",
          publicationOutcome: "unchanged",
        });
      },
      read: async () => ({ source: "A", revision: "rA" }),
      classifyFailure: classifyMarkdownPersistenceFailure,
      retryDelaysMs: [10, 20],
    });
    const host = mount(coordinator);
    await act(async () => {
      coordinator.change("B");
      void coordinator.flushNow();
      await vi.advanceTimersByTimeAsync(10);
    });
    // Still retrying: nothing to act on yet.
    expect(host.querySelector("[role=region]")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(attempts).toBe(3);
    const region = host.querySelector("[role=region]")!;
    expect(region.textContent).toContain("Couldn’t save: the disk is full.");
    expect(region.textContent).toContain("Your changes are still here.");
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Try again",
      "Details",
    ]);
    expect(coordinator.getSnapshot()).toMatchObject({ attention: null, draftSource: "B" });
  });

  it("words an unknown outcome the server proved unchanged as a refusal, details behind Details", async () => {
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "rA",
      write: async () => {
        throw new ProjectWriteFileError({
          cwd: "/synthetic",
          relativePath: "notes.md",
          failure: "operation_failed",
          osErrorCode: "ENOSPC",
          publicationOutcome: "unchanged",
        });
      },
      read: async () => ({ source: "A", revision: "rA" }),
      classifyFailure: () => "operation",
      describeOutcome: () => "unchanged",
    });
    const host = mount(coordinator);
    await act(async () => {
      coordinator.change("B");
      await coordinator.flushNow();
    });
    const region = host.querySelector("[role=region]")!;
    expect(region.textContent).toContain("Couldn’t save: the disk is full.");
    expect(region.textContent).toContain("Nothing was written. Your text is still here.");
    expect(region.textContent).not.toContain("notes.md");
    expect(host.querySelector("[data-persistence-reason]")).toBeNull();
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Show file on disk",
      "Continue from this version",
      "Details",
    ]);
    await act(() => click(host, "Details"));
    const details = host.querySelector("[data-persistence-reason]")!;
    expect(details.textContent).toContain("Failed to write workspace file 'notes.md'");
    expect(details.textContent).toContain("Code: ENOSPC");
    expect(coordinator.getSnapshot().draftSource).toBe("B");
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await act(async () => click(host, "Copy details"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Code: ENOSPC"));
    expect(host.textContent).toContain("Copied");
    // Different details are never shown as already copied.
    await act(async () =>
      coordinator.noteMutationFailure(
        new ProjectWriteFileError({
          cwd: "/synthetic",
          relativePath: "notes.md",
          failure: "operation_failed",
          osErrorCode: "EROFS",
          publicationOutcome: "unchanged",
        }),
      ),
    );
    if (!host.querySelector("[data-persistence-reason]")) await act(() => click(host, "Details"));
    expect(host.querySelector("[data-persistence-reason]")!.textContent).toContain("Code: EROFS");
    expect(host.textContent).toContain("Copy details");
    expect(host.textContent).not.toContain("Copied");
  });

  it("keeps one actionable failure after the retry budget is exhausted", async () => {
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "rA",
      write: async () => {
        throw new Error("offline");
      },
      read: async () => ({ source: "A", revision: "rA" }),
      classifyFailure: () => "transient",
      retryDelaysMs: [10, 20],
    });
    const host = mount(coordinator);
    await act(async () => {
      coordinator.change("B");
      void coordinator.flushNow();
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(host.querySelectorAll("[role=region]")).toHaveLength(1);
    expect(coordinator.getSnapshot().draftSource).toBe("B");
  });
  it("displays exact current disk bytes before acceptance and rejects a changed reviewed revision", async () => {
    const attention = {
      recoveryId: "notice-review",
      mutationId: "old",
      retainedPaths: ["/private/A"],
      message: "Review.",
    };
    let disk = { source: "Current C", revision: "rC", publicationAttention: attention };
    const resolve = vi.fn(async () => ({ revision: "rC" }));
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "rA",
      draftSource: "Local D",
      initialPublicationAttention: attention,
      read: async () => disk,
      resolve,
      write: async () => ({ revision: "unused" }),
      classifyFailure: () => "terminal",
    });
    const host = mount(coordinator);
    await act(() => click(host, "Continue from this version"));
    expect(resolve).not.toHaveBeenCalled();
    await act(async () => click(host, "Show file on disk"));
    expect(
      host.querySelector("[aria-label='Reviewed current disk version'] pre")?.textContent,
    ).toBe("Current C");
    disk = { source: "New external E", revision: "rE", publicationAttention: attention };
    await act(async () => click(host, "Continue from this version"));
    expect(resolve).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toMatchObject({
      attention: "recovery_required",
      draftSource: "Local D",
      baselineSource: "A",
    });
  });
});
