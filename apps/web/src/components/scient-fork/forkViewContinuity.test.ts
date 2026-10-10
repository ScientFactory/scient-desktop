import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createMemoryStorage } from "~/lib/storage";
import { type ThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { workspacePdfSource } from "~/scient/pdf/pdfSource";
import {
  pdfReaderSessionDocumentKey,
  pdfReaderSessionStore,
} from "~/scient/pdf/pdfReaderSessionStore";
import {
  forkRightPanelState,
  hasPendingForkPdfContinuity,
  stageForkViewContinuity,
  subscribeForkPdfContinuity,
  restoreForkPdfContinuity,
} from "./forkViewContinuity";

describe("forkRightPanelState", () => {
  it("preserves durable surfaces while replacing live browser state and dropping terminals", () => {
    const source: ThreadRightPanelState = {
      isOpen: true,
      activeSurfaceId: "browser:tab-2",
      surfaces: [
        { id: "files", kind: "files" },
        {
          id: "terminal:term-1",
          kind: "terminal",
          resourceId: "term-1",
          terminalIds: ["term-1"],
          activeTerminalId: "term-1",
        },
        { id: "browser:tab-1", kind: "preview", resourceId: "tab-1" },
        { id: "browser:tab-2", kind: "preview", resourceId: "tab-2" },
        {
          id: "file:papers/result.pdf",
          kind: "file",
          relativePath: "papers/result.pdf",
          revealLine: 12,
          revealRequestId: 4,
        },
        { id: "scient:sources", kind: "scient", module: "sources" },
      ],
    };

    expect(forkRightPanelState(source)).toEqual({
      isOpen: true,
      activeSurfaceId: "browser:new",
      surfaces: [
        { id: "files", kind: "files" },
        { id: "browser:new", kind: "preview", resourceId: null },
        {
          id: "file:papers/result.pdf",
          kind: "file",
          relativePath: "papers/result.pdf",
          revealLine: 12,
          revealRequestId: 4,
        },
        { id: "scient:sources", kind: "scient", module: "sources" },
      ],
    });
  });

  it("closes the destination panel when only live terminal state was open", () => {
    expect(
      forkRightPanelState({
        isOpen: true,
        activeSurfaceId: "terminal:term-1",
        surfaces: [
          {
            id: "terminal:term-1",
            kind: "terminal",
            resourceId: "term-1",
            terminalIds: ["term-1"],
            activeTerminalId: "term-1",
          },
        ],
      }),
    ).toEqual({ isOpen: false, activeSurfaceId: null, surfaces: [] });
  });

  it("uses the nearest durable surface when the active terminal is discarded", () => {
    expect(
      forkRightPanelState({
        isOpen: true,
        activeSurfaceId: "terminal:term-1",
        surfaces: [
          { id: "files", kind: "files" },
          {
            id: "terminal:term-1",
            kind: "terminal",
            resourceId: "term-1",
            terminalIds: ["term-1"],
            activeTerminalId: "term-1",
          },
          { id: "scient:sources", kind: "scient", module: "sources" },
        ],
      }),
    ).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [
        { id: "files", kind: "files" },
        { id: "scient:sources", kind: "scient", module: "sources" },
      ],
    });
  });
});

afterEach(() => vi.unstubAllGlobals());

it("remaps only retained attachments, including the active preview", () => {
  const file = (id: string) => ({
    id: `attachment:${id}` as const,
    kind: "file" as const,
    relativePath: "same-name.pdf",
    revealLine: null,
    revealRequestId: 1,
    attachment: {
      type: "file" as const,
      id,
      name: "same-name.pdf",
      mimeType: "application/pdf",
      sizeBytes: 20,
    },
  });
  const source: ThreadRightPanelState = {
    isOpen: true,
    activeSurfaceId: "attachment:origin-retained",
    surfaces: [file("origin-retained"), file("origin-excluded")],
  };
  const fork = forkRightPanelState(source, { "origin-retained": "fork-owned" });
  expect(fork.activeSurfaceId).toBe("attachment:fork-owned");
  expect(fork.surfaces).toHaveLength(1);
  expect(fork.surfaces[0]).toMatchObject({ attachment: { id: "fork-owned" } });
  expect(source.surfaces[0]).toMatchObject({ attachment: { id: "origin-retained" } });
  expect(forkRightPanelState(source).surfaces).toEqual([]);
  // A fork shares its history's files: the same preview stays open as it is.
  const shared = forkRightPanelState(source, { "origin-retained": "origin-retained" });
  expect(shared.activeSurfaceId).toBe("attachment:origin-retained");
  expect(shared.surfaces).toEqual([source.surfaces[0]]);
});

it.each(["/origin", "/new-worktree"])(
  "freezes and independently restores a fork PDF in %s",
  (destinationRoot) => {
    const environmentId = EnvironmentId.make(`continuity-${destinationRoot.slice(1)}`);
    const originRef = scopeThreadRef(environmentId, ThreadId.make("origin"));
    const forkId = ThreadId.make("fork");
    const source = (root: string) =>
      workspacePdfSource({
        environmentId,
        workspaceRoot: root,
        relativePath: "paper.pdf",
        fileName: "paper.pdf",
      });
    const originKey = pdfReaderSessionDocumentKey(source("/origin"), originRef.threadId);
    const forkKey = pdfReaderSessionDocumentKey(source(destinationRoot), forkId);
    const viewport = { page: 3, left: 12, top: 45, scaleValue: "1.25", rotation: 90 as const };
    vi.stubGlobal("window", { localStorage: createMemoryStorage() });
    useRightPanelStore.getState().restoreThreadState(originRef, {
      isOpen: true,
      activeSurfaceId: "file:paper.pdf",
      surfaces: [
        {
          id: "file:paper.pdf",
          kind: "file",
          relativePath: "paper.pdf",
          revealLine: null,
          revealRequestId: 1,
        },
      ],
    });
    pdfReaderSessionStore.updateViewport(originKey, viewport);
    pdfReaderSessionStore.updateSidebar(originKey, "outline");
    stageForkViewContinuity({
      originRef,
      destinationThreadId: forkId,
      originWorkspaceRoot: "/origin",
    });
    pdfReaderSessionStore.updateViewport(originKey, { ...viewport, page: 9 });
    restoreForkPdfContinuity({
      environmentId,
      threadId: forkId,
      destinationWorkspaceRoot: destinationRoot,
    });
    expect(pdfReaderSessionStore.get(forkKey)).toMatchObject({ viewport, sidebar: "outline" });
    pdfReaderSessionStore.updateViewport(forkKey, { ...viewport, page: 20 });
    expect(pdfReaderSessionStore.get(originKey).viewport?.page).toBe(9);
    restoreForkPdfContinuity({
      environmentId,
      threadId: forkId,
      destinationWorkspaceRoot: destinationRoot,
    });
    expect(pdfReaderSessionStore.get(forkKey).viewport?.page).toBe(20);
  },
);

it("keeps a fork's PDF positions pending until its folder is known, then only once", () => {
  const environmentId = EnvironmentId.make("continuity-pending");
  const originRef = scopeThreadRef(environmentId, ThreadId.make("origin"));
  const fork = { environmentId, threadId: ThreadId.make("fork") };
  vi.stubGlobal("window", { localStorage: createMemoryStorage() });
  useRightPanelStore.getState().restoreThreadState(originRef, {
    isOpen: true,
    activeSurfaceId: "file:paper.pdf",
    surfaces: [
      {
        id: "file:paper.pdf",
        kind: "file",
        relativePath: "paper.pdf",
        revealLine: null,
        revealRequestId: 1,
      },
    ],
  });
  // Normal threads never have anything pending, so their panel is never held.
  expect(hasPendingForkPdfContinuity(originRef)).toBe(false);
  const notified = vi.fn();
  const unsubscribe = subscribeForkPdfContinuity(notified);

  stageForkViewContinuity({
    originRef,
    destinationThreadId: fork.threadId,
    originWorkspaceRoot: "/origin",
  });
  expect(hasPendingForkPdfContinuity(fork)).toBe(true);

  // The fork's folder is not known yet (for example right after a reload).
  restoreForkPdfContinuity({ ...fork, destinationWorkspaceRoot: undefined });
  expect(hasPendingForkPdfContinuity(fork)).toBe(true);

  restoreForkPdfContinuity({ ...fork, destinationWorkspaceRoot: "/origin" });
  expect(hasPendingForkPdfContinuity(fork)).toBe(false);
  // Staging and applying both notify, so a held panel is released right away.
  expect(notified).toHaveBeenCalledTimes(2);
  unsubscribe();
});
