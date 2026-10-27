import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import { expect, it, vi } from "vite-plus/test";
import { useScientSettingsNavigation } from "./useScientSettingsNavigation";
import type { SettingsPath } from "../../components/settings/settingsSearch";
import settingsRouteSource from "../../routes/_chat.settings.tsx?raw";

type ObserveSettingsSectionVisibility =
  typeof import("./settingsSectionVisibility").observeSettingsSectionVisibility;

const mocks = vi.hoisted(() => ({
  resolvedPath: "/settings/general",
  navigate: vi.fn(),
  closeMobile: vi.fn(),
  mobile: false,
  scroll: vi.fn(() => true),
  observe: vi.fn(),
  observeForReal: undefined as ObserveSettingsSectionVisibility | undefined,
  stopObserving: vi.fn(),
}));
vi.mock("./settingsSectionVisibility", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settingsSectionVisibility")>();
  mocks.observeForReal = actual.observeSettingsSectionVisibility;
  return { ...actual, observeSettingsSectionVisibility: mocks.observe };
});
vi.mock("@tanstack/react-router", async (_actualRouter) => ({
  ...(await _actualRouter<typeof import("@tanstack/react-router")>()),
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
  { to: "/settings/providers", label: "Providers" },
];
const GENERAL_SECTION_IDS = ["notifications", "sidebar", "confirmations", "display"];
const APPEARANCE_SECTION_IDS = ["appearance", "appearance-interface", "typography"];

// A restart loop never settles inside act(), so starts past this bound are refused and the
// test fails on the start count instead of hanging.
const WATCHER_START_LIMIT = 100;
function observeWithRealWatcher(options: Parameters<ObserveSettingsSectionVisibility>[0]) {
  if (mocks.observe.mock.calls.length > WATCHER_START_LIMIT) return () => {};
  const stop = mocks.observeForReal!(options);
  return () => {
    mocks.stopObserving();
    stop();
  };
}

// The page is a 100px scroll root of 100px sections, so exactly one section fills the view.
function Probe({
  pathname,
  pageSectionIds,
}: {
  pathname: string;
  pageSectionIds: ReadonlyArray<string>;
}) {
  const sections = useScientSettingsNavigation(pathname, items);
  return (
    <>
      <ul>
        {items.map((item) => (
          <li key={item.to}>{sections(item)}</li>
        ))}
      </ul>
      {pageSectionIds.length > 0 ? (
        <div data-settings-page-scroll="" style={{ height: 100, overflowY: "auto" }}>
          {pageSectionIds.map((targetId) => (
            <section key={targetId} id={targetId} style={{ height: 100 }} />
          ))}
        </div>
      ) : null}
    </>
  );
}

async function _setupFixture0(_fixture: _Fixture) {
  mocks.resolvedPath = "/settings/general";
  mocks.mobile = false;
  mocks.navigate.mockReset();
  mocks.closeMobile.mockReset();
  mocks.scroll.mockReset().mockReturnValue(true);
  mocks.observe.mockReset().mockImplementation(observeWithRealWatcher);
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
const render = async (
  _fixture: _Fixture,
  pathname: string,
  pageSectionIds: ReadonlyArray<string> = [],
) =>
  await act(
    async () =>
      await _fixture.root0.rerender(<Probe pathname={pathname} pageSectionIds={pageSectionIds} />),
  );
const open = async (
  _fixture: _Fixture,
  path: string,
  pageSectionIds: ReadonlyArray<string> = [],
) => {
  mocks.resolvedPath = path;
  await render(_fixture, path, pageSectionIds);
};
const toggle = (_fixture: _Fixture) =>
  _fixture.container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const sectionButton = (_fixture: _Fixture, label: string) =>
  _fixture.root0.getByRole("button", { name: label, exact: true });
const pageScroll = (_fixture: _Fixture) =>
  _fixture.container.querySelector<HTMLElement>("[data-settings-page-scroll]")!;
const updateDepthErrors = (consoleError: { mock: { calls: ReadonlyArray<unknown[]> } }) =>
  consoleError.mock.calls.filter((args) =>
    args.some((arg) => String(arg).includes("Maximum update depth")),
  );

it("watches the open page once and highlights the sections in view as it scrolls", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);
  using consoleError = vi.spyOn(console, "error");
  _fixture.container.setAttribute("data-settings-page-layout", "");

  await open(_fixture, "/settings/general", GENERAL_SECTION_IDS);
  expect(mocks.observe).toHaveBeenCalledOnce();
  expect(updateDepthErrors(consoleError)).toEqual([]);

  await act(() => toggle(_fixture).click());
  await expect
    .element(sectionButton(_fixture, "Notifications"))
    .toHaveAttribute("data-visible", "true");
  expect(sectionButton(_fixture, "Notifications").element().classList).toContain("font-medium");
  expect(sectionButton(_fixture, "Display").element().classList).not.toContain("font-medium");
  expect(sectionButton(_fixture, "Display").element().getAttribute("data-visible")).toBe("false");

  pageScroll(_fixture).scrollTop = 250;
  await expect.element(sectionButton(_fixture, "Display")).toHaveAttribute("data-visible", "true");
  await expect
    .element(sectionButton(_fixture, "Notifications"))
    .toHaveAttribute("data-visible", "false");
  expect(mocks.observe).toHaveBeenCalledOnce();
  expect(mocks.stopObserving).not.toHaveBeenCalled();
  expect(updateDepthErrors(consoleError)).toEqual([]);
});

it("hands the watcher over to the next settings page", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);
  _fixture.container.setAttribute("data-settings-page-layout", "");

  await open(_fixture, "/settings/general", GENERAL_SECTION_IDS);
  await act(() => toggle(_fixture).click());
  await expect
    .element(sectionButton(_fixture, "Notifications"))
    .toHaveAttribute("data-visible", "true");

  await open(_fixture, "/settings/appearance", APPEARANCE_SECTION_IDS);
  expect(mocks.stopObserving).toHaveBeenCalledOnce();
  expect(mocks.observe).toHaveBeenCalledTimes(2);
  expect(mocks.observe).toHaveBeenLastCalledWith(
    expect.objectContaining({ targetIds: APPEARANCE_SECTION_IDS }),
  );
  await act(() => toggle(_fixture).click());
  await expect
    .element(sectionButton(_fixture, "Colors & themes"))
    .toHaveAttribute("data-visible", "true");
  expect(sectionButton(_fixture, "Interface").element().getAttribute("data-visible")).toBe("false");
  expect(mocks.observe).toHaveBeenCalledTimes(2);
});

it("does not carry a page's earlier results into a later visit to it", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);
  _fixture.container.setAttribute("data-settings-page-layout", "");

  await open(_fixture, "/settings/general", GENERAL_SECTION_IDS);
  await act(() => toggle(_fixture).click());
  await expect
    .element(sectionButton(_fixture, "Notifications"))
    .toHaveAttribute("data-visible", "true");

  await open(_fixture, "/settings/providers");
  expect(mocks.stopObserving).toHaveBeenCalledOnce();

  // Back on General before its page has mounted: nothing is in view yet.
  await open(_fixture, "/settings/general");
  expect(mocks.observe).toHaveBeenCalledTimes(2);
  expect(sectionButton(_fixture, "Notifications").element().getAttribute("data-visible")).toBe(
    "false",
  );

  await render(_fixture, "/settings/general", GENERAL_SECTION_IDS);
  await expect
    .element(sectionButton(_fixture, "Notifications"))
    .toHaveAttribute("data-visible", "true");
  expect(mocks.observe).toHaveBeenCalledTimes(2);
});

it("keeps the Settings page-root contract and scopes observer cleanup to navigation", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  // This cross-file DOM contract must survive upstream changes to the route shell.
  expect(settingsRouteSource).toMatch(/<div\b[^>]*\bdata-settings-page-layout\b/);
  _fixture.container.setAttribute("data-settings-page-layout", "");
  await render(_fixture, "/settings/general");
  expect(mocks.observe).toHaveBeenCalledWith({
    container: _fixture.container,
    targetIds: expect.arrayContaining(["notifications"]),
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
  const notifications = [..._fixture.container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Notifications",
  )!;
  await act(() => notifications.click());
  expect(mocks.closeMobile).toHaveBeenCalledWith(false);
  expect(mocks.scroll).toHaveBeenCalledWith("notifications", { highlight: false });
  expect(mocks.navigate).not.toHaveBeenCalled();
  mocks.scroll.mockReturnValue(false);
  await act(() => notifications.click());
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/settings/general",
    hash: "notifications",
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
