// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ComputeTable } from "./ComputeRichOutput";

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("bounded result tables", () => {
  it.each([false, true])(
    "uses the shared scroll viewport without losing values or truncation: %s",
    async (truncated) => {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      cleanups.push(async () => {
        await act(() => root.unmount());
      });
      await act(() =>
        root.render(
          <ComputeTable
            table={{
              columns: ["Label", "Value", "Missing"],
              rows: [["sample", 1.25, null]],
              truncated,
            }}
          />,
        ),
      );
      expect(container.querySelector("[data-slot=scroll-area-viewport]")).not.toBeNull();
      expect(container.querySelectorAll("th")).toHaveLength(3);
      const cells = container.querySelectorAll("td");
      expect(cells[1]!.textContent).toBe("1.25");
      expect(cells[1]!.className).toContain("text-end");
      expect(cells[2]!.textContent).toBe("—");
      expect(container.textContent?.includes("Limited preview")).toBe(truncated);
      expect(container.textContent).toContain("1 rows · 3 columns");
    },
  );
  it("retains table headers for an empty result", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanups.push(async () => {
      await act(() => root.unmount());
    });
    await act(() =>
      root.render(<ComputeTable table={{ columns: ["Value"], rows: [], truncated: false }} />),
    );
    expect(container.querySelector("th")?.textContent).toBe("Value");
    expect(container.querySelectorAll("td")).toHaveLength(0);
    expect(container.textContent).toContain("0 rows");
  });
});
