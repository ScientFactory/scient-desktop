import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useRightPanelStore } from "~/rightPanelStore";

import {
  goBackInTab,
  goForwardInTab,
  renameInTabHistory,
  type TabDepartureGuard,
  tabHistoryDepth,
  watchTabHistory,
} from "./tabHistory";

const stops: Array<() => void> = [];
let threadCount = 0;

/** A fresh thread with its history watched, as ChatView watches the open thread. */
function watchedThread(guard?: TabDepartureGuard): ScopedThreadRef {
  threadCount += 1;
  const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make(`history-${threadCount}`));
  stops.push(watchTabHistory(scopedThreadKey(ref), guard));
  return ref;
}

const panel = () => useRightPanelStore.getState();
const tabs = (ref: ScopedThreadRef) =>
  panel().byThreadKey[scopedThreadKey(ref)]?.surfaces.map((surface) => surface.id) ?? [];
const activeTab = (ref: ScopedThreadRef) =>
  panel().byThreadKey[scopedThreadKey(ref)]?.activeSurfaceId ?? null;

/** Files, then README opened from it in place: Files becomes README. */
function openReadmeFromFiles(ref: ScopedThreadRef) {
  panel().openFile(ref, ".");
  panel().navigateFolder(ref, "files", "README.md", "README.md");
}

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("tab history", () => {
  it("goes back and forward through a tab that changed in place", () => {
    const ref = watchedThread();
    openReadmeFromFiles(ref);
    expect(tabs(ref)).toEqual(["file:README.md"]);
    expect(tabHistoryDepth(ref, "file:README.md")).toEqual({ back: 1, forward: 0 });

    expect(goBackInTab(ref, "file:README.md")).toBe(true);
    expect(tabs(ref)).toEqual(["files"]);
    expect(tabHistoryDepth(ref, "files")).toEqual({ back: 0, forward: 1 });

    expect(goForwardInTab(ref, "files")).toBe(true);
    expect(tabs(ref)).toEqual(["file:README.md"]);
    expect(tabHistoryDepth(ref, "file:README.md")).toEqual({ back: 1, forward: 0 });
  });

  it("returns to the file tab a file was opened from, and forward again", () => {
    const ref = watchedThread();
    panel().openFile(ref, "a.md");
    panel().openFile(ref, "b.md");
    expect(tabHistoryDepth(ref, "file:b.md").back).toBe(1);

    goBackInTab(ref, "file:b.md");
    expect(activeTab(ref)).toBe("file:a.md");
    expect(tabHistoryDepth(ref, "file:a.md").forward).toBe(1);

    goForwardInTab(ref, "file:a.md");
    expect(activeTab(ref)).toBe("file:b.md");
  });

  it("records a move onto the tab already showing the file", () => {
    const ref = watchedThread();
    panel().openFile(ref, "README.md");
    panel().openFile(ref, ".");
    panel().navigateFolder(ref, "files", "README.md", "README.md");
    expect(tabs(ref)).toEqual(["file:README.md"]);
    expect(tabHistoryDepth(ref, "file:README.md").back).toBe(1);

    goBackInTab(ref, "file:README.md");
    expect(tabs(ref)).toEqual(["files"]);
  });

  it("keeps the way back to a browser tab, which has no history of its own", () => {
    const ref = watchedThread();
    panel().openBrowser(ref, "page-1");
    const browserId = activeTab(ref)!;
    panel().openFile(ref, "notes.md");

    goBackInTab(ref, "file:notes.md");
    expect(activeTab(ref)).toBe(browserId);
    expect(tabHistoryDepth(ref, browserId)).toEqual({ back: 0, forward: 0 });
    expect(tabHistoryDepth(ref, "file:notes.md").back).toBe(1);
  });

  it("does not take picking a tab in the strip for a move", () => {
    const ref = watchedThread();
    panel().openFile(ref, "a.md");
    panel().openFile(ref, "b.md");
    panel().activateSurface(ref, "file:a.md");
    expect(tabHistoryDepth(ref, "file:a.md")).toEqual({ back: 0, forward: 0 });
  });

  it("forgets a closed tab and every way back to it", () => {
    const ref = watchedThread();
    panel().openFile(ref, "a.md");
    panel().openFile(ref, "b.md");
    panel().closeSurface(ref, "file:a.md");
    expect(tabHistoryDepth(ref, "file:b.md").back).toBe(0);
  });

  it("starts a reopened file with no history", () => {
    const ref = watchedThread();
    openReadmeFromFiles(ref);
    panel().closeSurface(ref, "file:README.md");
    panel().openFile(ref, "README.md");
    expect(tabHistoryDepth(ref, "file:README.md")).toEqual({ back: 0, forward: 0 });
  });

  it("carries a renamed tab's history to its new path", () => {
    const ref = watchedThread();
    openReadmeFromFiles(ref);
    renameInTabHistory(ref, "README.md", "GUIDE.md", () =>
      panel().renameFileSurface(ref, "README.md", "GUIDE.md"),
    );
    expect(tabs(ref)).toEqual(["file:GUIDE.md"]);
    expect(tabHistoryDepth(ref, "file:GUIDE.md")).toEqual({ back: 1, forward: 0 });

    goBackInTab(ref, "file:GUIDE.md");
    expect(tabs(ref)).toEqual(["files"]);
    goForwardInTab(ref, "files");
    expect(tabs(ref)).toEqual(["file:GUIDE.md"]);
  });

  it("keeps both histories when a rename lands on a tab already open", () => {
    const ref = watchedThread();
    panel().openFile(ref, ".");
    panel().navigateFolder(ref, "files", "old.ts", "old.ts");
    panel().openFile(ref, "new.ts");
    panel().activateSurface(ref, "file:old.ts");
    renameInTabHistory(ref, "old.ts", "new.ts", () =>
      panel().renameFileSurface(ref, "old.ts", "new.ts"),
    );
    expect(tabs(ref)).toEqual(["file:new.ts"]);
    expect(tabHistoryDepth(ref, "file:new.ts")).toEqual({ back: 1, forward: 0 });

    goBackInTab(ref, "file:new.ts");
    expect(tabs(ref)).toEqual(["files"]);
  });

  it("waits for the departure guard, and moves only if history still leads there", () => {
    const waiting: Array<{ readonly target: string | null; readonly run: () => void }> = [];
    const ref = watchedThread((target, run) => waiting.push({ target, run }));
    openReadmeFromFiles(ref);

    expect(goBackInTab(ref, "file:README.md")).toBe(true);
    expect(waiting.map((entry) => entry.target)).toEqual(["files"]);
    expect(tabs(ref)).toEqual(["file:README.md"]);
    waiting[0]!.run();
    expect(tabs(ref)).toEqual(["files"]);

    goForwardInTab(ref, "files");
    panel().closeSurface(ref, "files");
    waiting[1]!.run();
    expect(tabs(ref)).toEqual([]);
  });
});
