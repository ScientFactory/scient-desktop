import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import { expect, it, vi } from "vite-plus/test";
import { useScientSettingsNavigation } from "./useScientSettingsNavigation";
import type { SettingsPath } from "../../components/settings/settingsSearch";
import settingsRouteSource from "../../routes/settings.tsx?raw";

const mocks = vi.hoisted(() => ({
  resolvedPath: "/settings/general",
  navigate: vi.fn(),
  preload: vi.fn(() => Promise.resolve([])),
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
vi.mock("@tanstack/react-router", async (_actualRouter) => ({
  ...(await _actualRouter<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ preloadRoute: mocks.preload }),
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

async function _setupFixture0(_fixture: _Fixture) {
  mocks.resolvedPath = "/settings/general";
  mocks.mobile = false;
  mocks.navigate.mockReset();
  mocks.closeMobile.mockReset();
  mocks.scroll.mockReset().mockReturnValue(true);
  mocks.observe.mockReset().mockReturnValue(mocks.stopObserving);
  mocks.stopObserving.mockReset();
  _fixture.container = document.createElement("div");
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.container.remove();
  vi.unstubAllGlobals();
}
const render = async (_fixture: _Fixture, pathname: string) =>
  await act(async () => await _fixture.root0.rerender(<Probe pathname={pathname} />));
const toggle = (_fixture: _Fixture) =>
  _fixture.container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;

it("keeps the Settings page-root contract and scopes observer cleanup to navigation", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  // This cross-file DOM contract must survive upstream changes to the route shell.
  expect(settingsRouteSource).toMatch(/<SidebarInset\b[^>]*\bdata-settings-page-layout\b/);
  _fixture.container.setAttribute("data-settings-page-layout", "");
  await render(_fixture, "/settings/general");
  expect(mocks.observe).toHaveBeenCalledWith({
    container: _fixture.container,
    targetIds: expect.arrayContaining(["organization"]),
    onChange: expect.any(Function),
  });
  mocks.resolvedPath = "/settings/appearance";
  await render(_fixture, "/settings/appearance");
  expect(mocks.stopObserving).toHaveBeenCalledTimes(1);
  await act(async () => await _fixture.root0.unmount());
  expect(mocks.stopObserving).toHaveBeenCalledTimes(2);
});

it("expands only by explicit choice and preserves the chosen page across navigation", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  await render(_fixture, "/settings/general");
  expect(toggle(_fixture).getAttribute("aria-expanded")).toBe("false");
  await act(() => toggle(_fixture).click());
  expect(toggle(_fixture).getAttribute("aria-expanded")).toBe("true");
  const target = toggle(_fixture).getAttribute("aria-controls")!;
  expect(document.getElementById(target)).not.toBeNull();
  mocks.resolvedPath = "/settings/appearance";
  await render(_fixture, "/settings/appearance");
  expect(toggle(_fixture).getAttribute("aria-expanded")).toBe("false");
  mocks.resolvedPath = "/settings/general";
  await render(_fixture, "/settings/general");
  expect(toggle(_fixture).getAttribute("aria-expanded")).toBe("true");
  await act(() => toggle(_fixture).click());
  expect(toggle(_fixture).getAttribute("aria-expanded")).toBe("false");
});

it("scrolls an existing section locally and falls back to hash navigation without highlighting", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  mocks.mobile = true;
  await render(_fixture, "/settings/general");
  await act(() => toggle(_fixture).click());
  const organization = [..._fixture.container.querySelectorAll<HTMLButtonElement>("button")].find(
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

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
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
