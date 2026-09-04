// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MarkdownPersistenceCoordinator } from "@scientfactory/scient-markdown";
import { EnvironmentId } from "@t3tools/contracts";
import type { MarkdownPersistenceLease } from "../persistence/markdownPersistenceRegistry";
import { ScientMarkdownPersistenceNotice } from "./ScientMarkdownPersistenceNotice";

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
  function mount(coordinator: MarkdownPersistenceCoordinator) {
    const persistence: MarkdownPersistenceLease = {
      target: {
        environmentId: EnvironmentId.make("test"),
        cwd: "/synthetic",
        relativePath: "notes.md",
      },
      getSnapshot: coordinator.getSnapshot,
      subscribe: coordinator.subscribe,
      change: (source, version) => coordinator.change(source, version),
      noteFreshnessHint: () => coordinator.noteFreshnessHint(),
      flushNow: () => coordinator.flushNow(),
      retry: () => coordinator.retry(),
      refresh: () => coordinator.refresh(),
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
    act(() => root.render(<ScientMarkdownPersistenceNotice persistence={persistence} />));
    return host;
  }
  function click(host: HTMLElement, text: string) {
    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === text,
    );
    expect(button).toBeDefined();
    button!.click();
  }

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
      "This file was changed by another writer",
    );
    expect(host.querySelector("[role=status] button")).toBeNull();
    expect(document.activeElement).toBe(input);
    await act(() => coordinator.change("C"));
    expect(host.querySelector("[role=status]")?.textContent).toBe(
      "This file was changed by another writer",
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
    await act(() => click(host, "Restore previous edits"));
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
    expect(host.textContent).not.toContain("Changes haven’t been saved");
    await act(() => coordinator.change("B"));
    expect(host.textContent).toContain("Changes haven’t been saved");
    expect(host.querySelector("[role=status]")?.textContent).toBe("Changes haven’t been saved");
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
    expect(host.querySelector("[role=status]")?.textContent).toBe("Changes haven’t been saved");
    expect(host.textContent).toContain("Keep this document open and retry");
    expect(coordinator.getSnapshot().draftSource).toBe("B");
  });
});
