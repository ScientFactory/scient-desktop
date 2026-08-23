// @vitest-environment happy-dom
// @effect-diagnostics console:off -- Qualification output records local performance evidence.

import { afterEach, describe, expect, it } from "vite-plus/test";

import { ScientMarkdownEditorView } from "./view";
import { ScientProseMirrorSession } from "./session";

function representativeDocument(minimumLength: number): string {
  const blocks: string[] = [];
  const encoder = new TextEncoder();
  let length = 0;
  let index = 1;
  while (length < minimumLength) {
    const block = `## Result ${index}\n\nMeasurement ${index}: mean **2.40** ± 0.12; תוצאה יציבה; see [[Methods/Protocol]].\n\n`;
    blocks.push(block);
    length += encoder.encode(block).byteLength;
    index += 1;
  }
  return blocks.join("");
}

function percentile(values: ReadonlyArray<number>, quantile: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

describe("Scient Markdown performance qualification", () => {
  const controllers: ScientMarkdownEditorView[] = [];

  afterEach(() => {
    controllers.splice(0).forEach((controller) => controller.destroy());
    document.body.replaceChildren();
  });

  it("keeps a 100 KiB source-preserving document responsive", () => {
    const source = representativeDocument(100 * 1024);
    const start = performance.now();
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "sha256:performance",
      mode: "write",
      ariaLabel: "Performance qualification document",
    });
    const constructedAt = performance.now();
    const host = document.createElement("div");
    document.body.append(host);
    controllers.push(controller);
    const view = controller.mount(host);
    const mountedAt = performance.now();

    const toggleStart = performance.now();
    for (let index = 0; index < 100; index += 1) {
      controller.setMode("read");
      controller.setMode("write");
    }
    const toggledAt = performance.now();

    const typingDurations: number[] = [];
    for (let index = 0; index < 60; index += 1) {
      const transactionStart = performance.now();
      view.dispatch(view.state.tr.insertText(index % 2 === 0 ? "a" : "ב", 1, 1));
      typingDurations.push(performance.now() - transactionStart);
    }
    const result = {
      bytes: new TextEncoder().encode(source).byteLength,
      constructMs: constructedAt - start,
      mountMs: mountedAt - constructedAt,
      toggleAverageMs: (toggledAt - toggleStart) / 200,
      typingP95Ms: percentile(typingDurations, 0.95),
    };
    console.info("SCIENT_MARKDOWN_PERFORMANCE", JSON.stringify(result));

    // Happy DOM is slower than Chromium for DOM creation but does not paint.
    // These bounds catch accidental algorithmic regressions; packaged-app
    // qualification separately enforces the product budgets.
    expect(result.constructMs).toBeLessThan(1_500);
    expect(result.mountMs).toBeLessThan(3_000);
    expect(result.toggleAverageMs).toBeLessThan(16);
    expect(result.typingP95Ms).toBeLessThan(16);
  });

  it("keeps 500 KiB source projection within the extended typing budget", () => {
    const source = representativeDocument(500 * 1024);
    const session = new ScientProseMirrorSession({
      source,
      revision: "sha256:large-performance",
      mode: "write",
    });
    const durations: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const start = performance.now();
      session.applyTransaction(
        session.state.tr.insertText(index % 2 === 0 ? "x" : "ש", 1, 1),
        "user",
      );
      durations.push(performance.now() - start);
    }
    const typingP95Ms = percentile(durations, 0.95);
    console.info(
      "SCIENT_MARKDOWN_LARGE_PERFORMANCE",
      JSON.stringify({
        bytes: new TextEncoder().encode(source).byteLength,
        typingP95Ms,
      }),
    );
    expect(typingP95Ms).toBeLessThan(32);
  });
});
