import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ReaderSearchField } from "./DocumentReaderControls";

// regression: a scanned PDF showed a standing banner over the page; its note now waits for a search.
describe("ReaderSearchField", () => {
  it("says why nothing was found only after Enter finds nothing", async () => {
    await using screen = await render(
      <ReaderSearchField
        label="Document"
        query="heart"
        current={0}
        total={0}
        notFound
        notFoundNote="This PDF's pages are images."
        focusRequest={1}
        onQuery={vi.fn()}
        onNavigate={vi.fn()}
        onClear={vi.fn()}
      />,
      { router: false },
    );
    const input = screen.container.querySelector("input")!;
    const note = () =>
      [...document.querySelectorAll('[role="status"]')].find(
        (element) => element.textContent === "This PDF's pages are images.",
      );
    expect(note()).toBeUndefined();
    await act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await vi.waitFor(() => expect(note()).toBeDefined());
    // Focus stays in the field, so typing goes on.
    expect(document.activeElement).toBe(input);
    await act(() => input.blur());
    await vi.waitFor(() => expect(note()).toBeUndefined());
  });
});
