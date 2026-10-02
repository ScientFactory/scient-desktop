// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import {
  MarkdownPersistenceRegistry,
  keepBothVersions,
  type MarkdownPersistenceLease,
} from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { useLatexSourceRecovery } from "./useLatexSourceRecovery";
import {
  checkpointVisualDraft,
  clearVisualDraft,
  flushVisualDraft,
  readPersistedVisualDraft,
} from "./visualDrafts";
import { parkUnpublishedSource, readStoredRecovery, removeRecovery } from "./visualRecovery";

const key = "synthetic-source-recovery";
const base = "\\documentclass{article}\n\\begin{document}Original.\\end{document}";
const mine = base.replace("Original", "Mine");
const newer = base.replace("Original", "Newer");

describe("Source recovery without a Visual editor", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  let lease: MarkdownPersistenceLease;
  let recovery: ReturnType<typeof useLatexSourceRecovery>;
  let disk: { source: string; revision: string };
  let presentation: string;
  const write = vi.fn();
  const openLease = () => {
    const registry = new MarkdownPersistenceRegistry({
      debounceMs: 5_000,
      reconcile: () => keepBothVersions,
      createTransport: () => ({
        read: async () => disk,
        write: async (intent) => {
          write(intent);
          if (intent.expectedRevision !== disk.revision) throw new Error("conflict");
          disk = { source: intent.source, revision: `${disk.revision}+` };
          return { revision: disk.revision };
        },
        classifyFailure: () => "conflict",
        subscribe: () => () => {},
        project: () => {},
      }),
    });
    return registry.acquire(
      {
        environmentId: EnvironmentId.make("recovery"),
        cwd: "/synthetic",
        relativePath: "paper.tex",
      },
      {
        contents: disk.source,
        revision: disk.revision,
        relativePath: "paper.tex",
        byteLength: disk.source.length,
        truncated: false,
      },
    )!;
  };
  function Host() {
    recovery = useLatexSourceRecovery(lease, key, presentation);
    return null;
  }
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    clearVisualDraft(key);
    write.mockClear();
    disk = { source: base, revision: "r1" };
    presentation = "visual";
    lease = openLease();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  const mount = () => act(async () => root.render(<Host />));
  afterEach(async () => {
    await act(async () => root.unmount());
    lease.release();
    container.remove();
    clearVisualDraft(key);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("checkpoints accepted Source typing, including pagehide before the coalesced write", async () => {
    await mount();
    await act(async () => {
      lease.change(mine, lease.getSnapshot().editVersion);
    });
    window.dispatchEvent(new Event("pagehide"));
    expect(readPersistedVisualDraft(key)).toEqual({ source: mine, baseRevision: "r1" });
    expect(write).not.toHaveBeenCalled();
  });
  it("offers a reopened source copy without writing, then applies only the compared version", async () => {
    checkpointVisualDraft(key, mine, base, mine, "r1");
    flushVisualDraft(key);
    await mount();
    expect(recovery.recovery?.source).toBe(mine);
    expect(lease.getSnapshot().draftSource).toBe(base);
    expect(write).not.toHaveBeenCalled();
    await act(async () => {
      lease.change(newer, lease.getSnapshot().editVersion);
    });
    await act(async () => {
      expect(recovery.apply(base)).toBe(false);
    });
    await act(async () => {
      expect(recovery.apply(newer)).toBe(true);
    });
    expect(lease.getSnapshot().draftSource).toBe(mine);
    expect(recovery.recovery).toBeNull();
    expect(readPersistedVisualDraft(key)?.source).toBe(mine);
    await act(async () => {
      expect(await lease.flushNow()).toBe(true);
    });
    expect(readPersistedVisualDraft(key)).toBeNull();
  });
  it("keeps offered work while new Source edits are saved", async () => {
    parkUnpublishedSource(key, mine, "r0");
    await mount();
    await act(async () => {
      lease.change(newer, lease.getSnapshot().editVersion);
    });
    await act(async () => {
      await lease.flushNow();
    });
    expect(recovery.recovery?.source).toBe(mine);
    expect(readStoredRecovery(key)?.source).toBe(mine);
    expect(disk.source).toBe(newer);
  });
  it("discards only the shown record when another independent recovery arrived", async () => {
    parkUnpublishedSource(key, mine, "r0");
    await mount();
    parkUnpublishedSource(key, newer, "r2");
    await act(async () => recovery.discard());
    expect(recovery.recovery?.source).toBe(newer);
    expect(readStoredRecovery(key)?.source).toBe(newer);
  });
  it("refreshes resolved Visual offers when returning to Source without parking current typing", async () => {
    parkUnpublishedSource(key, mine, "r0");
    await mount();
    removeRecovery(key, recovery.recovery!);
    await act(async () => {
      lease.change(newer, lease.getSnapshot().editVersion);
    });
    flushVisualDraft(key);
    presentation = "source";
    await mount();
    expect(recovery.recovery).toBeNull();
    expect(readPersistedVisualDraft(key)?.source).toBe(newer);
  });
  it("retains a newer checkpoint when an earlier save finishes", async () => {
    await mount();
    await act(async () => {
      lease.change(mine, lease.getSnapshot().editVersion);
    });
    checkpointVisualDraft(key, newer, base, newer, "r1");
    flushVisualDraft(key);
    await act(async () => {
      await lease.flushNow();
    });
    expect(readPersistedVisualDraft(key)?.source).toBe(newer);
  });
});
