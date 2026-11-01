import {
  DEFAULT_CLIENT_SETTINGS,
  type DiscoveredLocalServer,
  type PreviewSessionSnapshot,
  type ProjectScript,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

import { useProjectScriptAutoPreview } from "./useProjectScriptAutoPreview";

const mocks = vi.hoisted(() => ({
  servers: [] as ReadonlyArray<DiscoveredLocalServer>,
  recordVisitForThread: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("~/portDiscoveryState", () => ({
  useDiscoveredPortsState: () => ({ servers: mocks.servers, configuredUrlProbing: false }),
}));
vi.mock("~/browserHistoryStore", () => ({
  recordVisitForThread: mocks.recordVisitForThread,
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: mocks.toast },
}));

const threadRef = {
  environmentId: "preview-environment",
  threadId: "preview-thread",
} as ScopedThreadRef;

function script(previewUrl: string): ProjectScript {
  return {
    id: previewUrl,
    name: "Preview",
    command: "node app.mjs",
    icon: "play",
    autoOpenPreview: true,
    previewUrl,
    runOnWorktreeCreate: false,
  };
}

function snapshot(tabId: string, url: string): PreviewSessionSnapshot {
  return {
    threadId: threadRef.threadId,
    tabId,
    navStatus: { _tag: "Success", url, title: tabId },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-10-23T00:00:00.000Z",
  };
}

function deferredOpen() {
  const entered = Promise.withResolvers<void>();
  const receipt = Promise.withResolvers<Awaited<ReturnType<OpenPreviewMutation<never>>>>();
  return {
    entered: entered.promise,
    receipt,
    open: () => {
      entered.resolve();
      return receipt.promise;
    },
  };
}

function setup(openPreview: OpenPreviewMutation<never>) {
  mocks.servers = [];
  mocks.recordVisitForThread.mockReset();
  mocks.toast.mockReset();
  resetPreviewStateForTests();
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  const previous = useRightPanelStore.getState();
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  let launch: ReturnType<typeof useProjectScriptAutoPreview> | undefined;
  function Owner({
    activeThreadRef = threadRef,
    sessions = {},
    canFocus = true,
  }: {
    activeThreadRef?: ScopedThreadRef | null;
    sessions?: Readonly<Record<string, PreviewSessionSnapshot>>;
    canFocus?: boolean;
  }) {
    const open = useProjectScriptAutoPreview({
      activeThreadRef,
      activeTabId: null,
      sessions,
      openPreview,
      canFocusPreview: () => canFocus,
    });
    useLayoutEffect(() => {
      launch = open;
    }, [open]);
    return null;
  }
  return {
    Owner,
    launch: (url: string) => {
      if (!launch) throw new Error("The preview owner did not mount");
      return launch(script(url), threadRef);
    },
    [Symbol.dispose]() {
      resetPreviewStateForTests();
      useRightPanelStore.setState(previous);
    },
  };
}

function selectedSurface() {
  return selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef);
}

describe("project-script preview launch ownership", () => {
  it.each(["older-first", "newer-first"] as const)(
    "keeps the newest launch selected when acknowledgements arrive %s",
    async (order) => {
      using _bridge = stubGlobal("desktopBridge", { preview: {} });
      const older = deferredOpen();
      const newer = deferredOpen();
      const openPreview = vi
        .fn<OpenPreviewMutation<never>>()
        .mockImplementationOnce(older.open)
        .mockImplementationOnce(newer.open);
      using fixture = setup(openPreview);
      // This hook receives route identity explicitly and does not consume router context.
      await using _screen = await render(<fixture.Owner />, { router: false });
      const oldOpening = fixture.launch("https://example.test/older");
      await older.entered;
      const newOpening = fixture.launch("https://example.test/newer");
      await newer.entered;
      const deliveries = [
        () => {
          older.receipt.resolve(
            AsyncResult.success(snapshot("older", "https://example.test/older")),
          );
          return oldOpening;
        },
        () => {
          newer.receipt.resolve(
            AsyncResult.success(snapshot("newer", "https://example.test/newer")),
          );
          return newOpening;
        },
      ];
      for (const index of order === "older-first" ? [0, 1] : [1, 0]) {
        await act(deliveries[index]!);
      }
      expect(openPreview).toHaveBeenCalledTimes(2);
      expect(selectedSurface()).toMatchObject({ kind: "preview", resourceId: "newer" });
      expect(readThreadPreviewState(threadRef).activeTabId).toBe("newer");
      expect(mocks.recordVisitForThread).toHaveBeenCalledExactlyOnceWith(
        threadRef,
        "https://example.test/newer",
      );
      expect(mocks.toast).not.toHaveBeenCalled();
    },
  );

  it.each(["focus", "wait"] as const)(
    "supersedes an in-flight open when the next launch chooses %s",
    async (plan) => {
      using _bridge = stubGlobal("desktopBridge", { preview: {} });
      const older = deferredOpen();
      const ready = deferredOpen();
      const openPreview = vi
        .fn<OpenPreviewMutation<never>>()
        .mockImplementationOnce(older.open)
        .mockImplementationOnce(ready.open);
      using fixture = setup(openPreview);
      await using screen = await render(<fixture.Owner />, { router: false });
      const oldOpening = fixture.launch("https://example.test/older");
      await older.entered;
      const existing = snapshot("existing", "https://example.test/existing");
      const sessions = plan === "focus" ? { existing } : {};
      await screen.rerender(<fixture.Owner sessions={sessions} />);
      await act(() =>
        fixture.launch(
          plan === "focus" ? "https://example.test/existing" : "http://localhost:5173/",
        ),
      );
      const surfaceAfterLaunch = selectedSurface();
      older.receipt.resolve(AsyncResult.success(snapshot("older", "https://example.test/older")));
      await act(() => oldOpening);
      expect(selectedSurface()).toEqual(surfaceAfterLaunch);
      expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
      expect(mocks.recordVisitForThread).not.toHaveBeenCalled();
      if (plan === "wait") {
        mocks.servers = [
          {
            host: "localhost",
            port: 5173,
            url: "http://localhost:5173/",
            processName: "node",
            pid: 1,
            terminal: null,
          },
        ];
        await screen.rerender(<fixture.Owner />);
        await ready.entered;
        ready.receipt.resolve(AsyncResult.success(snapshot("ready", "http://localhost:5173/")));
        await vi.waitFor(() => expect(selectedSurface()?.id).toBe("browser:ready"));
        expect(readThreadPreviewState(threadRef).activeTabId).toBe("ready");
        expect(mocks.recordVisitForThread).toHaveBeenCalledExactlyOnceWith(
          threadRef,
          "http://localhost:5173/",
        );
      } else {
        expect(selectedSurface()?.id).toBe("browser:existing");
        expect(openPreview).toHaveBeenCalledTimes(1);
      }
      expect(mocks.toast).not.toHaveBeenCalled();
    },
  );

  it.each(["selection", "closed", "route", "pending-save", "unmount"] as const)(
    "does not publish a late acknowledgement after %s departure",
    async (departure) => {
      using _bridge = stubGlobal("desktopBridge", { preview: {} });
      const opening = deferredOpen();
      using fixture = setup(opening.open);
      await using screen = await render(<fixture.Owner />, { router: false });
      await act(() => useRightPanelStore.getState().openBrowser(threadRef, null));
      const pending = fixture.launch("https://example.test/app");
      await opening.entered;
      if (departure === "selection") {
        await act(() => useRightPanelStore.getState().openFile(threadRef, "notes.md"));
      } else if (departure === "closed") {
        await act(() => useRightPanelStore.getState().close(threadRef));
      } else if (departure === "route") {
        await screen.rerender(<fixture.Owner activeThreadRef={null} />);
      } else if (departure === "pending-save") {
        await screen.rerender(<fixture.Owner canFocus={false} />);
      } else {
        await screen.unmount();
      }
      const surfaceBeforeAck = selectedSurface();
      opening.receipt.resolve(AsyncResult.success(snapshot("late", "https://example.test/app")));
      await act(() => pending);
      expect(selectedSurface()).toEqual(surfaceBeforeAck);
      expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
      expect(mocks.recordVisitForThread).not.toHaveBeenCalled();
      expect(mocks.toast).not.toHaveBeenCalled();
    },
  );
});
