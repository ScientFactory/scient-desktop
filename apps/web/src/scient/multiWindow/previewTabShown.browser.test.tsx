import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { usePreviewTabShownHere, useShowPreviewStartPage } from "./previewTabShown";

function StartPage({ tabId }: { readonly tabId: string | null }) {
  useShowPreviewStartPage(tabId);
  return null;
}

function Shown({ tabId }: { readonly tabId: string }) {
  return <output>{usePreviewTabShownHere(tabId) ? "shown" : "hidden"}</output>;
}

it("counts a tab's start page on screen as showing the tab in this window", async () => {
  await using screen = await render(
    <>
      <StartPage tabId={null} />
      <Shown tabId="start-page-tab" />
    </>,
    { router: false },
  );
  await expect.element(screen.getByText("hidden")).toBeVisible();

  await screen.rerender(
    <>
      <StartPage tabId="start-page-tab" />
      <Shown tabId="start-page-tab" />
    </>,
  );
  await expect.element(screen.getByText("shown")).toBeVisible();

  await screen.rerender(
    <>
      <StartPage tabId={null} />
      <Shown tabId="start-page-tab" />
    </>,
  );
  await expect.element(screen.getByText("hidden")).toBeVisible();
});
