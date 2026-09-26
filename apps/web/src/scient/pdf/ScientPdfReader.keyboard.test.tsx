// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { ScientPdfReader } from "./ScientPdfReader";
import { workspacePdfSource } from "./pdfSource";
import {
  DEFAULT_KEYBOARD_PREFERENCES,
  reloadKeyboardPreferences,
  saveKeyboardPreferences,
} from "../keyboard/preferences";
import { surfaceOwnsShortcut } from "../keyboard/ownership";

const reader = vi.hoisted(() => ({
  state: {
    error: null,
    findCount: { current: 0, total: 0 },
    findPhase: "idle",
    outline: [],
    page: 1,
    pageCount: 1,
    passwordReason: null,
    phase: "ready",
    progress: null,
    rotation: 0,
    scanned: false,
    scale: 1,
  },
  presentation: null,
  runtimeRef: { current: null },
  setZoom: vi.fn(),
  setZoomMode: vi.fn(),
  prepareSearch: vi.fn(),
  closeSearch: vi.fn(),
  goToPage: vi.fn(),
  rotate: vi.fn(),
  setSearchQuery: vi.fn(),
  findAgain: vi.fn(),
}));
vi.mock("./useScientPdfReader", () => ({
  useScientPdfReader: (input: {
    documentKey: string;
    revisionId: string | null;
    sourceUrl: string;
    container: HTMLDivElement | null;
  }) => ({
    ...reader,
    presentation: {
      documentKey: input.documentKey,
      revisionId: input.revisionId,
      sourceUrl: input.sourceUrl,
      container: input.container ?? document.createElement("div"),
    },
  }),
}));
const source = workspacePdfSource({
  environmentId: EnvironmentId.make("keyboard-test"),
  fileName: "test.pdf",
  workspaceRoot: "/fixture",
  relativePath: "test.pdf",
});
const resolver = {
  useResolve: () => ({
    _tag: "Success" as const,
    url: "https://example.invalid/test.pdf",
    expiresAt: Date.now() + 3600000,
    refresh: () => {},
  }),
};
let root: Root, host: HTMLDivElement;
function key(value: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: value,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  event.getModifierState = () => false;
  return event;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  reloadKeyboardPreferences();
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<ScientPdfReader source={source} resolver={resolver} />));
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  localStorage.clear();
  reloadKeyboardPreferences();
  vi.unstubAllGlobals();
});
it("find owns only its exact chord and closes with Escape", async () => {
  const target = host.querySelector<HTMLElement>(".scient-pdf-reader")!;
  await act(() => target.dispatchEvent(key("f", { ctrlKey: true, shiftKey: true })));
  expect(host.querySelector(".scient-pdf-searchbar")).toBeNull();
  const event = key("f", { ctrlKey: true });
  await act(() => target.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(host.querySelector(".scient-pdf-searchbar")).not.toBeNull();
  await act(() => target.dispatchEvent(key("Escape")));
  expect(host.querySelector(".scient-pdf-searchbar")).toBeNull();
});
it("uses document zoom without claiming application zoom and updates active bindings", async () => {
  const target = host.querySelector<HTMLElement>(".scient-pdf-reader")!;
  const appZoom = key("=", { ctrlKey: true });
  target.dispatchEvent(appZoom);
  expect(appZoom.defaultPrevented).toBe(false);
  expect(reader.setZoom).not.toHaveBeenCalled();
  await act(() => target.dispatchEvent(key("ArrowUp", { altKey: true })));
  expect(reader.setZoom).toHaveBeenCalledExactlyOnceWith(1.05);
  await act(() =>
    saveKeyboardPreferences({
      ...DEFAULT_KEYBOARD_PREFERENCES,
      overrides: { "pdf.zoomIn": ["alt+q"] },
    }),
  );
  reader.setZoom.mockClear();
  await act(() => target.dispatchEvent(key("ArrowUp", { altKey: true })));
  expect(reader.setZoom).not.toHaveBeenCalled();
  await act(() => target.dispatchEvent(key("q", { altKey: true })));
  expect(reader.setZoom).toHaveBeenCalledExactlyOnceWith(1.05);
});
it("advertises ownership before capture and respects an already consumed event", async () => {
  const target = host.querySelector<HTMLElement>(".scient-pdf-reader")!;
  let claimed = false;
  const capture = (event: KeyboardEvent) => {
    claimed = surfaceOwnsShortcut(event);
  };
  window.addEventListener("keydown", capture, true);
  try {
    await act(() => target.dispatchEvent(key("f", { ctrlKey: true })));
    expect(claimed).toBe(true);
  } finally {
    window.removeEventListener("keydown", capture, true);
  }
  const consumed = key("ArrowDown", { altKey: true });
  consumed.preventDefault();
  await act(() => target.dispatchEvent(consumed));
  expect(reader.setZoom).not.toHaveBeenCalled();
});
