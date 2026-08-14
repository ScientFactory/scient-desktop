import { describe, expect, it } from "vite-plus/test";

import type { ThreadRightPanelState } from "~/rightPanelStore";
import { forkRightPanelState } from "./forkViewContinuity";

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
