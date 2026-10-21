import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import { expect, it, vi } from "vite-plus/test";
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
    presentationCurrent: true,
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

function key(value: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: value,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  return event;
}
async function _setupFixture0(_fixture: _Fixture) {
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux");
  _fixture.cleanup.defer(() => platform.mockRestore());

  localStorage.clear();
  reloadKeyboardPreferences();
  vi.clearAllMocks();
  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await act(
    async () =>
      await _fixture.root0.rerender(<ScientPdfReader source={source} resolver={resolver} />),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.host.remove();
  localStorage.clear();
  reloadKeyboardPreferences();
  vi.unstubAllGlobals();
}
it("find owns only its exact chord and puts the caret in the search field", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const target = _fixture.host.querySelector<HTMLElement>(".scient-pdf-reader")!;
  const field = () =>
    _fixture.host.querySelector<HTMLInputElement>('input[aria-label="Search PDF"]')!;
  expect(field()).not.toBeNull();
  await act(() => target.dispatchEvent(key("f", { ctrlKey: true, shiftKey: true })));
  expect(document.activeElement).not.toBe(field());
  const event = key("f", { ctrlKey: true });
  await act(() => target.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(field());
  // There is no separate search bar any more.
  expect(_fixture.host.querySelector(".scient-pdf-searchbar")).toBeNull();
});
it("uses document zoom without claiming application zoom and updates active bindings", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const target = _fixture.host.querySelector<HTMLElement>(".scient-pdf-reader")!;
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
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const target = _fixture.host.querySelector<HTMLElement>(".scient-pdf-reader")!;
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

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
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
