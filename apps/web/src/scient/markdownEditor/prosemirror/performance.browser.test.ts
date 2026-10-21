// @effect-diagnostics console:off -- Qualification output records local performance evidence.

import { describe, expect, it } from "vite-plus/test";

import { ScientMarkdownEditorView } from "./view";
import { ScientProseMirrorSession } from "./session";

const strictQualification = process.env.SCIENT_MARKDOWN_PERF_STRICT === "1";
// A CI web shard runs headless Chromium beside this suite, so CI measures it in its own step.
const sharedCiRunner = process.env.SCIENT_MARKDOWN_PERF_SHARED_RUNNER === "1";

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

describe.skipIf(sharedCiRunner)("Scient Markdown performance qualification", () => {
  async function _cleanupFixture0(_fixture: _Fixture) {
    _fixture.controllers.splice(0).forEach((controller) => controller.destroy());
    _clearOwnedDOM(_fixture);
    document.documentElement.classList.remove("dark");
  }

  it("keeps a 100 KiB source-preserving document responsive", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

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
    document.body.append(_ownDOM(_fixture, host));
    _fixture.controllers.push(controller);
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

  it("keeps 500 KiB source projection within the extended typing budget", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

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

  it.each(["table", "references"])("bounds typing work for a 100 KiB %s document", async (kind) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

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
    const durations: number[] = [];
    for (let index = 0; index < 30; index++) {
      const start = performance.now();
      session.applyTransaction(session.state.tr.insertText("x", position!, position!), "user");
      durations.push(performance.now() - start);
    }
    expect(percentile(durations, 0.95)).toBeLessThan(strictQualification ? 16 : 64);
  });

  it("keeps a code-dense document on persistent surfaces across presentation changes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

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
    document.body.append(_ownDOM(_fixture, host));
    _fixture.controllers.push(controller);
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

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    controllers: [] as ScientMarkdownEditorView[],
    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
