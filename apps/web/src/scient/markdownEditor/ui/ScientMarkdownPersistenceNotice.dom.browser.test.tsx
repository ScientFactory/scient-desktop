import {
  render as _fixtureRender,
  type Screen,
  stubGlobal as _fixtureStubGlobal,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../../test/render";
import { useState } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import { MarkdownPersistenceCoordinator } from "@scientfactory/scient-markdown";
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
  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.stack.use(_fixtureFakeTimers());
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    for (const root of _fixture.root0.splice(0)) await act(async () => await root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    _clearOwnedDOM(_fixture);
  }
  async function mount(
    _fixture: _Fixture,
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
    document.body.append(_ownDOM(_fixture, host));
    const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
    _fixture.root0.push(root);
    await act(
      async () =>
        await root.rerender(
          <ScientMarkdownPersistenceNotice persistence={persistence} {...extra} />,
        ),
    );
    return host;
  }

  function click(host: HTMLElement, text: string) {
    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === text,
    );
    expect(button).toBeDefined();
    button!.click();
  }

  it("returns to Rich past an outstanding source-line reveal without publishing pending input", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    document.body.append(_ownDOM(_fixture, host));
    const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
    _fixture.root0.push(root);
    await act(async () => await root.rerender(<PanelViewState />));
    expect(host.querySelector("[data-view]")?.textContent).toBe("Source editor");
    await act(() => click(host, "Return to Rich"));
    expect(host.querySelector("[data-view]")?.textContent).toBe("Rich editor");
    expect(lease.getPendingInput()).toBe(pending);
    expect(lease.getSnapshot().draftSource).toBe("Saved source");
    expect(write).not.toHaveBeenCalled();
    lease.release();
  });

  it("keeps both quick and slow routine saves silent, including screen readers", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const write = deferred<{ revision: string }>();
    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "rA",
      write: () => write.promise,
      read: async () => ({ source: "B", revision: "rB" }),
      classifyFailure: () => "terminal",
    });
    const host = await mount(_fixture, coordinator);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "rA",
      write: async () => {
        throw new Error("protocol failure");
      },
      read: async () => ({ source: "A", revision: "rA" }),
      classifyFailure: () => "terminal",
    });
    const host = await mount(_fixture, coordinator);
    await act(async () => {
      coordinator.change("B");
      await coordinator.flushNow();
    });
    expect(host.querySelector("[role=region]")).not.toBeNull();
    expect(host.querySelector("[data-persistence-reason]")).toBeNull();
  });

  it("shows no conflict until ordered verification and keeps actions outside the live region", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    const host = await mount(_fixture, coordinator);
    const input = document.createElement("input");
    document.body.append(_ownDOM(_fixture, input));
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "rA",
      write: async () => {
        throw new Error("cas");
      },
      read: async () => ({ source: "External", revision: "rX" }),
      classifyFailure: () => "conflict",
    });
    const host = await mount(_fixture, coordinator);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "rA",
      write: async () => ({ revision: "unused" }),
      read: async () => {
        throw new Error("permission denied");
      },
      classifyFailure: () => "terminal",
    });
    const host = await mount(_fixture, coordinator);
    await act(async () => coordinator.noteFreshnessHint());
    expect(coordinator.getSnapshot().pending).toBe(false);
    expect(host.textContent).toContain("This file couldn’t be refreshed");
    expect(host.textContent).not.toContain("Couldn’t save");
    await act(() => coordinator.change("B"));
    expect(host.textContent).toContain("Couldn’t save");
    expect(host.querySelector("[role=status]")?.textContent).toBe("Couldn’t save");
  });

  it("explains a moved file and offers the same-name files as other documents", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    const host = await mount(_fixture, coordinator, {
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const coordinator = new MarkdownPersistenceCoordinator({
      source: "A",
      revision: "rA",
      write: async () => {
        throw new Error("cas");
      },
      read: async () => ({ source: "External", revision: "rX" }),
      classifyFailure: () => "conflict",
    });
    const host = await mount(_fixture, coordinator);
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

  it("keeps saving and gives the reason and a way to keep the text, not a Try again", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    const host = await mount(_fixture, coordinator);
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
    expect(attempts).toBeGreaterThan(3);
    const region = host.querySelector("[role=region]")!;
    expect(region.textContent).toContain("Couldn’t save: the disk is full.");
    expect(region.textContent).toContain("Your text is still here, and Scient keeps trying.");
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Save a copy",
      "Details",
    ]);
    expect(coordinator.getSnapshot()).toMatchObject({ attention: null, draftSource: "B" });
  });

  it("keeps one actionable failure after the retry budget is exhausted", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    const host = await mount(_fixture, coordinator);
    await act(async () => {
      coordinator.change("B");
      void coordinator.flushNow();
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(host.querySelectorAll("[role=region]")).toHaveLength(1);
    expect(coordinator.getSnapshot().draftSource).toBe("B");
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    stack,
    cleanup,
    root0: [] as Screen[],
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
