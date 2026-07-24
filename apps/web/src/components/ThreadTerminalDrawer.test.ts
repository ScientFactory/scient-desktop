import { describe, expect, it, vi } from "vitest";

import {
  executeTerminalSelectionAction,
  normalizeTerminalClipboardText,
  resolveTerminalSelectionActionPosition,
  runTerminalSelectionMenuAction,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionCopyFailureMessage,
  terminalSelectionActionDelayForClickCount,
} from "./terminal/terminalSelectionActions";

describe("normalizeTerminalClipboardText", () => {
  it("removes per-line terminal padding while preserving CRLF line endings", () => {
    expect(normalizeTerminalClipboardText("first  \r\nsecond\t \r\nthird   ")).toBe(
      "first\r\nsecond\r\nthird",
    );
  });

  it("preserves leading indentation and internal whitespace", () => {
    expect(normalizeTerminalClipboardText("  indented  value \t kept   \n\tnext line\t")).toBe(
      "  indented  value \t kept\n\tnext line",
    );
  });

  it("returns already-normalized selections unchanged", () => {
    const selection = "  leading indentation\r\ninternal  spaces and\ttabs";
    expect(normalizeTerminalClipboardText(selection)).toBe(selection);
  });
});

describe("resolveTerminalSelectionActionPosition", () => {
  it("prefers the selection rect over the last pointer position", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: { right: 260, bottom: 140 },
        pointer: { x: 520, y: 200 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 260,
      y: 144,
    });
  });

  it("falls back to the pointer position when no selection rect is available", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 180, y: 130 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 180,
      y: 130,
    });
  });

  it("clamps the pointer fallback into the terminal drawer bounds", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 720, y: 340 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 600,
      y: 270,
    });

    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 40, y: 20 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("delays multi-click selection actions so triple-click selection can complete", () => {
    expect(terminalSelectionActionDelayForClickCount(1)).toBe(0);
    expect(terminalSelectionActionDelayForClickCount(2)).toBe(260);
    expect(terminalSelectionActionDelayForClickCount(3)).toBe(260);
  });

  it("only handles mouseup when the selection gesture started in the terminal", () => {
    expect(shouldHandleTerminalSelectionMouseUp(true, 0)).toBe(true);
    expect(shouldHandleTerminalSelectionMouseUp(false, 0)).toBe(false);
    expect(shouldHandleTerminalSelectionMouseUp(true, 1)).toBe(false);
  });
});

describe("executeTerminalSelectionAction", () => {
  it("copies normalized terminal text, preserves the selection, and restores focus", async () => {
    const copyText = vi.fn(async () => undefined);
    const addToChat = vi.fn();
    const clearSelection = vi.fn();
    const focusTerminal = vi.fn();
    const reportCopyError = vi.fn();

    await executeTerminalSelectionAction({
      action: "copy",
      clipboardText: "raw\r\nselection  ",
      selection: { text: "normalized\nselection" },
      copyText,
      addToChat,
      clearSelection,
      focusTerminal,
      reportCopyError,
      isCurrent: () => true,
    });

    expect(copyText).toHaveBeenCalledWith("raw\r\nselection");
    expect(addToChat).not.toHaveBeenCalled();
    expect(clearSelection).not.toHaveBeenCalled();
    expect(reportCopyError).not.toHaveBeenCalled();
    expect(focusTerminal).toHaveBeenCalledOnce();
  });

  it("reports a whitespace-only selection instead of preserving stale clipboard data", async () => {
    const copyText = vi.fn(async () => undefined);
    const reportCopyError = vi.fn();
    const focusTerminal = vi.fn();

    await executeTerminalSelectionAction({
      action: "copy",
      clipboardText: "   \r\n\t  ",
      selection: { text: "   \n\t  " },
      copyText,
      addToChat: vi.fn(),
      clearSelection: vi.fn(),
      focusTerminal,
      reportCopyError,
      isCurrent: () => true,
    });

    expect(copyText).not.toHaveBeenCalled();
    expect(reportCopyError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "The selection contains no copyable text." }),
    );
    expect(focusTerminal).toHaveBeenCalledOnce();
  });

  it("keeps Add to chat normalization and selection lifecycle unchanged", async () => {
    const selection = { text: "normalized\nselection" };
    const addToChat = vi.fn();
    const clearSelection = vi.fn();
    const focusTerminal = vi.fn();

    await executeTerminalSelectionAction({
      action: "add-to-chat",
      clipboardText: "raw selection  ",
      selection,
      copyText: vi.fn(async () => undefined),
      addToChat,
      clearSelection,
      focusTerminal,
      reportCopyError: vi.fn(),
      isCurrent: () => true,
    });

    expect(addToChat).toHaveBeenCalledWith(selection);
    expect(clearSelection).toHaveBeenCalledOnce();
    expect(focusTerminal).toHaveBeenCalledOnce();
  });

  it("reports clipboard rejection and does not apply stale async completions", async () => {
    let current = true;
    const error = new Error("clipboard unavailable");
    const reportCopyError = vi.fn();
    const focusTerminal = vi.fn();

    await executeTerminalSelectionAction({
      action: "copy",
      clipboardText: "selection",
      selection: { text: "selection" },
      copyText: async () => {
        current = false;
        throw error;
      },
      addToChat: vi.fn(),
      clearSelection: vi.fn(),
      focusTerminal,
      reportCopyError,
      isCurrent: () => current,
    });

    expect(reportCopyError).not.toHaveBeenCalled();
    expect(focusTerminal).not.toHaveBeenCalled();

    current = true;
    await executeTerminalSelectionAction({
      action: "copy",
      clipboardText: "selection",
      selection: { text: "selection" },
      copyText: async () => {
        throw error;
      },
      addToChat: vi.fn(),
      clearSelection: vi.fn(),
      focusTerminal,
      reportCopyError,
      isCurrent: () => current,
    });

    expect(reportCopyError).toHaveBeenCalledWith(error);
    expect(focusTerminal).toHaveBeenCalledOnce();
  });
});

describe("runTerminalSelectionMenuAction", () => {
  it("releases the menu single-flight guard before awaiting clipboard work", async () => {
    let resolveCopy: (() => void) | undefined;
    const releaseMenu = vi.fn();
    const execute = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve;
        }),
    );

    const actionPromise = runTerminalSelectionMenuAction({
      showMenu: async () => "copy" as const,
      releaseMenu,
      isCurrent: () => true,
      execute,
    });

    await vi.waitFor(() => {
      expect(releaseMenu).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith("copy");
    });
    expect(resolveCopy).toBeTypeOf("function");

    resolveCopy?.();
    await actionPromise;
  });
});

describe("terminalSelectionCopyFailureMessage", () => {
  it("provides stable recovery guidance while preserving the underlying reason", () => {
    expect(terminalSelectionCopyFailureMessage(new Error("Document is not focused"))).toBe(
      "Unable to copy terminal selection. Check clipboard access or use Cmd/Ctrl+C, then retry. (Document is not focused)",
    );
  });
});
