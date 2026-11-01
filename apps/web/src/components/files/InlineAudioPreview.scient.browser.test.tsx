import { expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../../test/render";
import { InlineAudioPreview } from "./InlineAudioPreview";

vi.mock(import("~/assets/assetUrls"), () => ({
  useAssetUrlState: () => ({ _tag: "Loading", refresh: () => undefined }),
}));

// The real observer waits for a rendered frame, which CI can hold back past any wait.
class InViewIntersectionObserver {
  private readonly callback: (entries: ReadonlyArray<{ isIntersecting: boolean }>) => void;
  constructor(callback: (entries: ReadonlyArray<{ isIntersecting: boolean }>) => void) {
    this.callback = callback;
  }
  observe() {
    this.callback([{ isIntersecting: true }]);
  }
  disconnect() {}
}

it("loads external audio only after the reader requests it", async () => {
  using _observer = stubGlobal("IntersectionObserver", InViewIntersectionObserver);
  await using screen = await render(
    <InlineAudioPreview name="recording.wav" src="https://audio.invalid/recording.wav" />,
  );
  expect(screen.container.querySelector("audio")).toBeNull();
  await screen.getByRole("button", { name: "Load audio recording.wav" }).click();
  await vi.waitFor(() =>
    expect(screen.container.querySelector("audio")?.getAttribute("src")).toBe(
      "https://audio.invalid/recording.wav",
    ),
  );
  await screen.rerender(
    <InlineAudioPreview name="next.wav" src="https://audio.invalid/next.wav" />,
  );
  expect(screen.container.querySelector("audio")).toBeNull();
});
