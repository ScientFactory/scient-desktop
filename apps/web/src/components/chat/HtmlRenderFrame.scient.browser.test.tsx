import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { htmlRenderTheme, HTML_RENDER_DEFAULT_FONTS } from "@t3tools/shared/htmlRender";
import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import "~/index.css";
import { render as renderUi } from "../../../test/render";

import { HtmlRenderFrame } from "./HtmlRenderFrame";
const { cachedUrl, refresh, showError, openLink, openChangeRequestLink } = vi.hoisted(() => ({
  cachedUrl: {
    lifeMs: 60 * 60_000,
  },
  refresh: vi.fn(),
  showError: vi.fn(),
  openLink: vi.fn(),
  openChangeRequestLink: vi.fn(),
}));
vi.mock(import("~/browser/useOpenLink"), async (original) => ({
  ...(await original()),
  useOpenLink: () => openLink,
}));
vi.mock(import("~/lib/openPullRequestLink"), async (original) => ({
  ...(await original()),
  useOpenChangeRequestLink: () => openChangeRequestLink,
}));
vi.mock(import("~/assets/longLivedAssetUrls"), async (original) => ({
  ...(await original()),
  useLongLivedAssetUrl: () => ({
    _tag: "Success",
    url: "https://environment.test/original.html",
    expiresAt: Date.now() + cachedUrl.lifeMs,
    refresh: () => {},
  }),
}));
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: () => ({
    _tag: "Success",
    url: "https://environment.test/original.html",
    expiresAt: Date.now() + cachedUrl.lifeMs,
    // SCIENT-FORK: Scient's asset states carry their own refresh.
    refresh: () => {},
  }),
  useAssetUrlRefresh: () => refresh,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: showError,
    },
  };
});
vi.mock(import("~/hooks/useHtmlRenderTheme"), async (original) => ({
  ...(await original()),
  useHtmlRenderTheme: () =>
    htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark", HTML_RENDER_DEFAULT_FONTS),
}));
const onClose = vi.fn();
function setup() {
  refresh.mockReset();
  cachedUrl.lifeMs = 60 * 60_000;
  openLink.mockReset().mockResolvedValue(undefined);
  openChangeRequestLink.mockReset().mockReturnValue(false);
  showError.mockClear();
  onClose.mockClear();
}

function button(label: string) {
  return page.getByRole("button", {
    name: label,
    exact: true,
  });
}

// A trusted click, so the page also gets the user activation the link handler requires.
async function click(label: string) {
  await button(label).click();
}

// SCIENT-FORK:START — Scient keeps Open in panel (source, Save) beside full screen.
it("opens the page in the file panel when the thread offers one", async () => {
  const onOpen = vi.fn();
  setup();
  await using _screen = await renderUi(
    <HtmlRenderFrame
      environmentId={EnvironmentId.make("environment")}
      htmlRender={{
        attachmentId: "html",
        title: "Diagram",
        height: 400,
      }}
      threadRef={{
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make("thread"),
      }}
      onOpen={onOpen}
    />,
  );
  expect(document.querySelector('[aria-label="Open full screen"]')).not.toBeNull();
  await click("Open in panel");
  expect(onOpen).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "file",
      id: "html",
      mimeType: "text/html",
      htmlRender: true,
    }),
  );
  expect(refresh).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
// SCIENT-FORK:END
