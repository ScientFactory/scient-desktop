import "~/index.css";

import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { BrowserTabHoverCard } from "./BrowserTabHoverCard";

const capture = vi.hoisted(() => vi.fn());
vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { captureTabThumbnail: capture },
}));

it("removes the pending placeholder when the page changes while the card is open", async () => {
  const pending = Promise.withResolvers<string | null>();
  capture.mockReset();
  capture.mockReturnValue(pending.promise);
  const card = (url: string) => (
    <BrowserTabHoverCard
      trigger={<button type="button">Browser tab</button>}
      title="Page"
      url={url}
      runtimeTabId="regression-tab"
      incognito={false}
      active={false}
      navEpoch="epoch"
    />
  );
  // No router is needed for this isolated hover card.
  await using screen = await render(card("https://example.com/first"), { router: false });
  screen.getByRole("button", { name: "Browser tab" }).element().focus();
  await expect.poll(() => capture.mock.calls.length).toBe(1);
  await expect.poll(() => document.querySelectorAll(".aspect-\\[16\\/10\\]")).toHaveLength(1);

  await screen.rerender(card("https://example.com/second"));
  await expect.poll(() => document.querySelectorAll(".aspect-\\[16\\/10\\]")).toHaveLength(0);
  pending.resolve(null);
});
