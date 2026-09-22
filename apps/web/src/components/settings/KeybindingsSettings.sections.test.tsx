// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
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
vi.mock("../../state/server", () => ({
  serverEnvironment: { upsertKeybinding: "upsert", removeKeybinding: "remove" },
}));
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

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<KeybindingsSettingsPanel />));
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  localStorage.clear();
  location.hash = "";
  vi.unstubAllGlobals();
});

function section(name: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button[aria-controls]")].find(
    (candidate) => candidate.textContent?.includes(name),
  );
  expect(button, name).toBeTruthy();
  return button!;
}

it("opens Math when a settings search first navigates to authoring", async () => {
  await act(() => root.unmount());
  location.hash = "authoring";
  root = createRoot(host);
  await act(() => root.render(<KeybindingsSettingsPanel />));
  expect(section("Math").getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector('[aria-label^="Edit math.symbol.alpha"]')).not.toBeNull();
});

it("uses the shared selector for four persistent, isolated shortcut sections", async () => {
  expect(host.textContent).toContain("Shortcuts");
  const sourceGroup = host.querySelector(".settings-source-group");
  const sectionSurface = sourceGroup?.parentElement?.parentElement;
  expect(sectionSurface?.classList.contains("space-y-1")).toBe(true);
  expect(sectionSurface?.classList.contains("rounded-xl")).toBe(false);
  expect(sourceGroup?.querySelectorAll("[data-source-panel]")).toHaveLength(1);
  expect([...host.querySelectorAll(".settings-source-strip button")]).toHaveLength(4);
  expect(section("General").getAttribute("aria-expanded")).toBe("true");
  expect(host.textContent).toContain("Appearance: Cycle");
  expect(host.textContent).not.toContain("Document shortcut profile");

  await act(() => section("Markdown").click());
  expect(section("Markdown").getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector('[aria-label^="Edit markdown.bold"]')).not.toBeNull();
  expect(host.querySelector('[aria-label^="Edit math.symbol.alpha"]')).toBeNull();
  expect(host.textContent).toContain("Import");
  expect(host.querySelector('[aria-label="Add keybinding"]')).toBeNull();

  await act(() => section("Math").click());
  expect(host.querySelector('[aria-label^="Edit math.symbol.alpha"]')).not.toBeNull();
  expect(host.textContent).toContain("Math input behavior and preset");
  const mathOptions = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.textContent?.includes("Math input behavior and preset"),
  )!;
  const importAction = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === "Import",
  )!;
  expect(mathOptions.parentElement).toBe(importAction.parentElement?.parentElement);
  expect(mathOptions.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector("#math-input-behavior")).toBeNull();
  await act(() => mathOptions.click());
  expect(mathOptions.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector("#math-input-behavior")).toBeNull();
  expect(document.querySelector("#math-input-behavior")).not.toBeNull();
  expect(document.querySelector("#math-input-behavior")?.textContent).toContain(
    "Applies to Markdown, Math, and PDF shortcuts.",
  );
  expect(host.querySelector('[aria-label^="Edit markdown.bold"]')).toBeNull();

  await act(() => section("PDF").click());
  expect(document.querySelector("#math-input-behavior")).toBeNull();
  expect(host.querySelector('[aria-label^="Edit pdf.zoomIn"]')).not.toBeNull();
  expect(host.querySelector('[aria-label^="Edit math.symbol.alpha"]')).toBeNull();

  await act(() => section("PDF").click());
  expect(section("PDF").getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector("[data-source-panel]")?.id).toBe("keybindings-pdf");
});
