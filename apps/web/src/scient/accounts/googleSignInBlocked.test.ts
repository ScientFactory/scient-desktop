import { EnvironmentId, type DesktopPreviewTabState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import {
  noteGoogleSignInBlocked,
  noteTabState,
  useGoogleSignInBlocked,
} from "./googleSignInBlocked";

vi.mock("../analytics/accountBrowserAnalytics", () => ({
  recordAccountBrowserEvent: () => undefined,
}));

const PAGE = "https://www.overleaf.com/login";
const at = (url: string) =>
  ({ navStatus: { kind: "Success", url, title: "" } }) as unknown as DesktopPreviewTabState;

it("drops a stopped sign-in once its tab leaves the page, so coming back doesn't revive it", () => {
  noteGoogleSignInBlocked(EnvironmentId.make("synthetic"), {
    tabId: "tab_1",
    page: "transit",
    context: "popup",
    restartUrl: "https://www.overleaf.com/",
    pageUrl: PAGE,
  });
  noteTabState("tab_1", at(PAGE));
  expect(useGoogleSignInBlocked.getState().byTabId.tab_1?.pageUrl).toBe(PAGE);
  noteTabState("tab_1", at("https://example.com/"));
  noteTabState("tab_1", at(PAGE));
  expect(useGoogleSignInBlocked.getState().byTabId.tab_1).toBeUndefined();
});
