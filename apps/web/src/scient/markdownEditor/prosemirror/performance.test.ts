// @vitest-environment happy-dom
// @effect-diagnostics console:off -- Qualification output records local performance evidence.

import { afterEach, describe, expect, it } from "vite-plus/test";

import { ScientMarkdownEditorView } from "./view";
import { ScientProseMirrorSession } from "./session";

const strictQualification = process.env.SCIENT_MARKDOWN_PERF_STRICT === "1";

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
    document.documentElement.classList.remove("dark");
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

    // The normal parallel suite catches gross algorithmic regressions without
    // confusing machine contention for editor latency. The dedicated isolated
    // lane sets SCIENT_MARKDOWN_PERF_STRICT=1 and enforces the product typing
    // budget; packaged-app qualification still measures real painting.
    expect(result.constructMs).toBeLessThan(1_500);
    expect(result.mountMs).toBeLessThan(3_000);
    expect(result.toggleAverageMs).toBeLessThan(strictQualification ? 16 : 32);
    expect(result.typingP95Ms).toBeLessThan(strictQualification ? 16 : 64);
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
    expect(typingP95Ms).toBeLessThan(strictQualification ? 32 : 128);
  });

  it("keeps a code-dense document on persistent surfaces across presentation changes", () => {
    const source = Array.from(
      { length: 64 },
      (_, index) => `\`\`\`typescript\nconst value${index}: number = ${index};\n\`\`\`\n`,
    ).join("\n");
    const controller = new ScientMarkdownEditorView({
      source,
      revision: "sha256:code-dense-performance",
      mode: "write",
      ariaLabel: "Code-dense performance qualification document",
    });
    const host = document.createElement("div");
    document.body.append(host);
    controllers.push(controller);
    const mountStart = performance.now();
    const view = controller.mount(host);
    const mountMs = performance.now() - mountStart;
    const editors = Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-editor"));

    expect(editors).toHaveLength(64);
    expect(mountMs).toBeLessThan(3_000);

    controller.setMode("read");
    expect(
      Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-content")).every(
        (content) => content.getAttribute("contenteditable") === "false",
      ),
    ).toBe(true);
    controller.setMode("write");
    document.documentElement.classList.add("dark");
    controller.refreshExternalPresentation("appearance");

    const editorsAfterPresentationChanges = Array.from(
      view.dom.querySelectorAll<HTMLElement>(".cm-editor"),
    );
    expect(editorsAfterPresentationChanges).toHaveLength(editors.length);
    editorsAfterPresentationChanges.forEach((editor, index) => {
      expect(editor).toBe(editors[index]);
    });
    expect(
      Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-content")).every(
        (content) => content.getAttribute("contenteditable") === "true",
      ),
    ).toBe(true);
    expect(controller.session.session.draftSource).toBe(source);
  });
});
