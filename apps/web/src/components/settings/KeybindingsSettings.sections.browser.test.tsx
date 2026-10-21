import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { type ReactNode } from "react";

import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

const environmentId = EnvironmentId.make("shortcut-sections");
const location = vi.hoisted(() => ({ hash: "" }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: () => location.hash,
  useNavigate: () => vi.fn(),
}));
vi.mock("../../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(async () => ({ _tag: "Success" })),
}));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  usePrimarySettingsAvailable: () => true,
}));
vi.mock("../../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/server")>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      upsertKeybinding: "upsert",
      removeKeybinding: "remove",
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(async () => ({ _tag: "Success", value: null })),
}));
vi.mock("./SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => null,
  useSettingsScope: () => ({
    environment: {
      environmentId,
      serverConfig: {
        keybindings: [],
        keybindingsConfigPath: "/fixture/keybindings.json",
        availableEditors: [],
      },
    },
    connectedEnvironments: [{ environmentId }],
  }),
}));
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

import { KeybindingsSettingsPanel } from "./KeybindingsSettings";

async function _setupFixture0(_fixture: _Fixture) {
  localStorage.clear();
  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await act(async () => await _fixture.root0.rerender(<KeybindingsSettingsPanel />));
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.host.remove();
  localStorage.clear();
  location.hash = "";
  vi.unstubAllGlobals();
}

function section(_fixture: _Fixture, name: string) {
  const button = [
    ..._fixture.host.querySelectorAll<HTMLButtonElement>("button[aria-controls]"),
  ].find((candidate) => candidate.textContent?.includes(name));
  expect(button, name).toBeTruthy();
  return button!;
}

it("opens Math when a settings search first navigates to authoring", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await act(async () => await _fixture.root0.unmount());
  location.hash = "authoring";
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await act(async () => await _fixture.root0.rerender(<KeybindingsSettingsPanel />));
  expect(section(_fixture, "Math").getAttribute("aria-expanded")).toBe("true");
  expect(_fixture.host.querySelector('[aria-label^="Edit math.symbol.alpha"]')).not.toBeNull();
});

it("uses the shared selector for six persistent, isolated shortcut sections", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  expect(_fixture.host.textContent).toContain("Shortcuts");
  const sourceGroup = _fixture.host.querySelector(".settings-source-group");
  const sectionSurface = sourceGroup?.parentElement?.parentElement;
  expect(sectionSurface?.classList.contains("space-y-1")).toBe(true);
  expect(sectionSurface?.classList.contains("rounded-xl")).toBe(false);
  expect(sourceGroup?.querySelectorAll("[data-source-panel]")).toHaveLength(1);
  expect([..._fixture.host.querySelectorAll(".settings-source-strip button")]).toHaveLength(6);
  expect(section(_fixture, "General").getAttribute("aria-expanded")).toBe("true");
  expect(_fixture.host.textContent).toContain("Appearance: Cycle");
  expect(_fixture.host.textContent).not.toContain("Document shortcut profile");

  await act(() => section(_fixture, "Write").click());
  expect(_fixture.host.querySelector('[aria-label^="Edit latex.bold"]')).not.toBeNull();
  expect(_fixture.host.querySelector('[aria-label^="Edit table.addRow"]')).toBeNull();
  await act(() => section(_fixture, "Tables").click());
  expect(_fixture.host.querySelector('[aria-label^="Edit table.addRow"]')).not.toBeNull();
  expect(_fixture.host.querySelector('[aria-label^="Edit latex.bold"]')).toBeNull();

  await act(() => section(_fixture, "Markdown").click());
  expect(section(_fixture, "Markdown").getAttribute("aria-expanded")).toBe("true");
  expect(_fixture.host.querySelector('[aria-label^="Edit markdown.bold"]')).not.toBeNull();
  expect(_fixture.host.querySelector('[aria-label^="Edit math.symbol.alpha"]')).toBeNull();
  expect(_fixture.host.textContent).toContain("Import");
  expect(_fixture.host.querySelector('[aria-label="Add keybinding"]')).toBeNull();

  await act(() => section(_fixture, "Math").click());
  expect(_fixture.host.querySelector('[aria-label^="Edit math.symbol.alpha"]')).not.toBeNull();
  expect(_fixture.host.textContent).toContain("Math input behavior and preset");
  const mathOptions = [..._fixture.host.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes("Math input behavior and preset"),
  )!;
  const importAction = [..._fixture.host.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === "Import",
  )!;
  expect(mathOptions.parentElement).toBe(importAction.parentElement?.parentElement);
  expect(mathOptions.getAttribute("aria-expanded")).toBe("false");
  expect(_fixture.host.querySelector("#math-input-behavior")).toBeNull();
  await act(() => mathOptions.click());
  expect(mathOptions.getAttribute("aria-expanded")).toBe("true");
  expect(_fixture.host.querySelector("#math-input-behavior")).toBeNull();
  expect(document.querySelector("#math-input-behavior")).not.toBeNull();
  expect(document.querySelector("#math-input-behavior")?.textContent).toContain(
    "Applies to Write, Tables, Markdown, Math, and PDF shortcuts.",
  );
  expect(_fixture.host.querySelector('[aria-label^="Edit markdown.bold"]')).toBeNull();

  await act(() => section(_fixture, "PDF").click());
  expect(document.querySelector("#math-input-behavior")).toBeNull();
  expect(_fixture.host.querySelector('[aria-label^="Edit pdf.zoomIn"]')).not.toBeNull();
  expect(_fixture.host.querySelector('[aria-label^="Edit math.symbol.alpha"]')).toBeNull();

  await act(() => section(_fixture, "PDF").click());
  expect(section(_fixture, "PDF").getAttribute("aria-expanded")).toBe("true");
  expect(_fixture.host.querySelector("[data-source-panel]")?.id).toBe("keybindings-pdf");
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
