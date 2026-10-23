// @effect-diagnostics console:off -- Qualification output records local performance evidence.
import type { EditorView } from "prosemirror-view";
import { expect, it } from "vite-plus/test";

import { ScientMarkdownEditorView } from "./view";
import { ScientProseMirrorSession } from "./session";

const strictQualification = process.env.SCIENT_MARKDOWN_PERF_STRICT === "1";
const singleSample = { time: 0, iterations: 1, warmup: false } as const;
// Auto-detection calls a workload once before timing, which would consume a cold mount.
const synchronous = { async: false } as const;

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

it("keeps a 100 KiB source-preserving document responsive", async ({ bench }) => {
  using cleanup = new DisposableStack();
  const source = representativeDocument(100 * 1024);
  const host = document.createElement("div");
  document.body.append(host);
  cleanup.defer(() => host.remove());
  const captured: { controller?: ScientMarkdownEditorView; view?: EditorView } = {};
  cleanup.defer(() => captured.controller?.destroy());
  const construction = await bench("construct 100 KiB", synchronous, () => {
    captured.controller = new ScientMarkdownEditorView({
      source,
      revision: "sha256:performance",
      mode: "write",
      ariaLabel: "Performance qualification document",
    });
  }).run(singleSample);
  const controller = captured.controller!;
  const mounting = await bench("mount 100 KiB", synchronous, () => {
    captured.view = controller.mount(host);
  }).run(singleSample);
  const toggling = await bench("100 read/write mode pairs", synchronous, () => {
    for (let index = 0; index < 100; index++) {
      controller.setMode("read");
      controller.setMode("write");
    }
  }).run(singleSample);
  let index = 0;
  const typing = await bench("type into 100 KiB", synchronous, () => {
    const view = captured.view!;
    view.dispatch(view.state.tr.insertText(index++ % 2 === 0 ? "a" : "ב", 1, 1));
  }).run({ time: 0, iterations: 60, warmup: false, retainSamples: true });
  expect(typing.latency.samples).toHaveLength(60);
  expect(index).toBe(60);
  const result = {
    bytes: new TextEncoder().encode(source).byteLength,
    constructMs: construction.latency.mean,
    mountMs: mounting.latency.mean,
    toggleAverageMs: toggling.latency.mean / 200,
    typingP95Ms: percentile(typing.latency.samples!, 0.95),
  };
  console.info("SCIENT_MARKDOWN_PERFORMANCE", JSON.stringify(result));
  expect(result.constructMs).toBeLessThan(1_500);
  expect(result.mountMs).toBeLessThan(3_000);
  expect(result.toggleAverageMs).toBeLessThan(strictQualification ? 16 : 32);
  expect(result.typingP95Ms).toBeLessThan(strictQualification ? 16 : 64);
});

it("keeps 500 KiB source projection within the extended typing budget", async ({ bench }) => {
  const source = representativeDocument(500 * 1024);
  const session = new ScientProseMirrorSession({
    source,
    revision: "sha256:large-performance",
    mode: "write",
  });
  let index = 0;
  const result = await bench("type into 500 KiB", synchronous, () => {
    session.applyTransaction(
      session.state.tr.insertText(index++ % 2 === 0 ? "x" : "ש", 1, 1),
      "user",
    );
  }).run({ time: 0, iterations: 30, warmup: false, retainSamples: true });
  expect(result.latency.samples).toHaveLength(30);
  expect(index).toBe(30);
  const typingP95Ms = percentile(result.latency.samples!, 0.95);
  console.info(
    "SCIENT_MARKDOWN_LARGE_PERFORMANCE",
    JSON.stringify({ bytes: new TextEncoder().encode(source).byteLength, typingP95Ms }),
  );
  expect(typingP95Ms).toBeLessThan(strictQualification ? 32 : 128);
});

it.for(["table", "references"])(
  "bounds typing work for a 100 KiB %s document",
  async (kind, { bench }) => {
    let source = kind === "table" ? "| A | B |\n| --- | --- |\n" : "";
    for (let index = 0; source.length < 100 * 1024; index++) {
      source +=
        kind === "table"
          ? `| sample ${index} | stable measurement **2.40** and detailed text |\n`
          : `Paragraph ${index}: stable measurement **2.40** and detailed text.\n\n`;
    }
    if (kind === "references") source += "[reference]: https://example.org\n";
    const session = new ScientProseMirrorSession({ source, revision: "r1", mode: "write" });
    let position: number | undefined;
    session.state.doc.descendants((node, offset) => {
      if (position === undefined && node.isText) position = offset;
    });
    const result = await bench(`type into ${kind}`, synchronous, () => {
      session.applyTransaction(session.state.tr.insertText("x", position!, position!), "user");
    }).run({ time: 0, iterations: 30, warmup: false, retainSamples: true });
    expect(result.latency.samples).toHaveLength(30);
    expect(percentile(result.latency.samples!, 0.95)).toBeLessThan(strictQualification ? 16 : 64);
  },
);

it("mounts 64 persistent code surfaces within budget", async ({ bench }) => {
  using cleanup = new DisposableStack();
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
  cleanup.defer(() => host.remove());
  cleanup.defer(() => controller.destroy());
  const result = await bench("mount 64 code surfaces", synchronous, () =>
    controller.mount(host),
  ).run(singleSample);
  expect(host.querySelectorAll(".cm-editor")).toHaveLength(64);
  expect(result.latency.mean).toBeLessThan(3_000);
});
