import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ReaderSearchField } from "./DocumentReaderControls";
import "./documentReaderControls.css";

// regression: a scanned PDF showed a standing banner over the page; its note now waits for a search.
describe("ReaderSearchField", () => {
  it("keeps the query editable beside match counts and recognition progress in a narrow reader", async () => {
    await using screen = await render(
      <div className="scient-document-controls" style={{ width: 120 }}>
        <div style={{ display: "flex" }}>
          <ReaderSearchField
            label="PDF"
            query="Verapamil"
            current={32}
            total={34}
            notFound={false}
            status={{ label: "Reading 12/40", description: "12 pages read" }}
            focusRequest={1}
            onQuery={vi.fn()}
            onNavigate={vi.fn()}
            onClear={vi.fn()}
          />
        </div>
      </div>,
      { router: false },
    );
    const input = screen.container.querySelector("input")!;
    expect(input.getBoundingClientRect().width).toBeGreaterThan(30);
    await screen.getByRole("textbox", { name: "Search PDF" }).fill("Calcium");
    const field = screen.container.querySelector(".scient-reader-search-box")!;
    for (const button of field.querySelectorAll("button")) {
      expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(
        field.getBoundingClientRect().right,
      );
    }
  });

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
