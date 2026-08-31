import { describe, expect, it } from "vite-plus/test";
import { hasPdfLayout } from "./pdfLayout";

describe("PDF layout readiness", () => {
  it("requires connected nodes, positive dimensions, and a page layout parent", () => {
    const container = { isConnected: true, clientWidth: 400, clientHeight: 600 };
    const viewer = { isConnected: true, offsetParent: {} as object | null };
    const ready = () => hasPdfLayout(container as HTMLDivElement, viewer as HTMLDivElement);
    expect(ready()).toBe(true);
    for (const field of ["clientWidth", "clientHeight"] as const) {
      const previous = container[field];
      container[field] = 0;
      expect(ready()).toBe(false);
      container[field] = previous;
      expect(ready()).toBe(true);
    }
    container.isConnected = false;
    expect(ready()).toBe(false);
    container.isConnected = true;
    viewer.isConnected = false;
    expect(ready()).toBe(false);
    viewer.isConnected = true;
    viewer.offsetParent = null;
    expect(ready()).toBe(false);
    viewer.offsetParent = {};
    expect(ready()).toBe(true);
  });
});
