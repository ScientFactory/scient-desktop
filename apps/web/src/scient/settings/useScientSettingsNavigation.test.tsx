// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useScientSettingsNavigation } from "./useScientSettingsNavigation";
import type { SettingsPath } from "../../components/settings/settingsSearch";
import settingsRouteSource from "../../routes/settings.tsx?raw";

const mocks = vi.hoisted(() => ({
  resolvedPath: "/settings/general",
  navigate: vi.fn(),
  closeMobile: vi.fn(),
  mobile: false,
  scroll: vi.fn(() => true),
  observe: vi.fn(),
  stopObserving: vi.fn(),
}));
vi.mock("./settingsSectionVisibility", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsSectionVisibility")>()),
  observeSettingsSectionVisibility: mocks.observe,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useRouterState: () => mocks.resolvedPath,
}));
vi.mock("../../components/settings/settingsLayout", () => ({
  scrollToSettingsTarget: mocks.scroll,
}));
vi.mock("../../components/ui/sidebar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/ui/sidebar")>()),
  useSidebar: () => ({ isMobile: mocks.mobile, setOpenMobile: mocks.closeMobile }),
}));
const items: ReadonlyArray<{ to: SettingsPath; label: string }> = [
  { to: "/settings/general", label: "General" },
  { to: "/settings/appearance", label: "Appearance" },
];
function Probe({ pathname }: { pathname: string }) {
  const sections = useScientSettingsNavigation(pathname, items);
  return (
    <ul>
      {items.map((item) => (
        <li key={item.to}>{sections(item)}</li>
      ))}
    </ul>
  );
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.resolvedPath = "/settings/general";
  mocks.mobile = false;
  mocks.navigate.mockReset();
  mocks.closeMobile.mockReset();
  mocks.scroll.mockReset().mockReturnValue(true);
  mocks.observe.mockReset().mockReturnValue(mocks.stopObserving);
  mocks.stopObserving.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = (pathname: string) => act(() => root.render(<Probe pathname={pathname} />));
const toggle = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;

it("keeps the Settings page-root contract and scopes observer cleanup to navigation", async () => {
  // This cross-file DOM contract must survive upstream changes to the route shell.
  expect(settingsRouteSource).toMatch(/<SidebarInset\b[^>]*\bdata-settings-page-layout\b/);
  container.setAttribute("data-settings-page-layout", "");
  await render("/settings/general");
  expect(mocks.observe).toHaveBeenCalledWith({
    container,
    targetIds: expect.arrayContaining(["organization"]),
    onChange: expect.any(Function),
  });
  mocks.resolvedPath = "/settings/appearance";
  await render("/settings/appearance");
  expect(mocks.stopObserving).toHaveBeenCalledTimes(1);
  await act(() => root.unmount());
  expect(mocks.stopObserving).toHaveBeenCalledTimes(2);
});

it("expands only by explicit choice and preserves the chosen page across navigation", async () => {
  await render("/settings/general");
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  await act(() => toggle().click());
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  const target = toggle().getAttribute("aria-controls")!;
  expect(document.getElementById(target)).not.toBeNull();
  mocks.resolvedPath = "/settings/appearance";
  await render("/settings/appearance");
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  mocks.resolvedPath = "/settings/general";
  await render("/settings/general");
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  await act(() => toggle().click());
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
});

it("scrolls an existing section locally and falls back to hash navigation without highlighting", async () => {
  mocks.mobile = true;
  await render("/settings/general");
  await act(() => toggle().click());
  const organization = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Organization",
  )!;
  await act(() => organization.click());
  expect(mocks.closeMobile).toHaveBeenCalledWith(false);
  expect(mocks.scroll).toHaveBeenCalledWith("organization", { highlight: false });
  expect(mocks.navigate).not.toHaveBeenCalled();
  mocks.scroll.mockReturnValue(false);
  await act(() => organization.click());
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/settings/general",
    hash: "organization",
    replace: true,
    hashScrollIntoView: false,
    state: { settingsTargetHighlight: false },
  });
});
