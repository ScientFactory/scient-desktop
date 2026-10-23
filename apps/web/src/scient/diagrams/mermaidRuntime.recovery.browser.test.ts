import { describe, expect, it, vi } from "vite-plus/test";
import { recoveryFixtures } from "./mermaidRecovery.fixtures";

const native = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("../../components/chat/MermaidDiagram", () => ({ renderMermaidSvg: native.render }));
const good = { svg: '<svg><g id="node" /></svg>', diagramType: "flowchart-v2" };
const syntaxError = () => new Error("Parse error on line 3:\nOriginal source diagnostic");

// Browser modules persist; authored comments isolate scenarios without bypassing the cache.
const scenarioSource = (name: string) => `${recoveryFixtures[0].source}\n%% ${name}`;

describe("Mermaid runtime recovery transaction", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    native.render.mockReset();
  }
  it("renders all compatible fixes together, caches their provenance and rebases each consumer", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const fixture = recoveryFixtures.find((entry) => entry.name === "multiple independent issues")!;
    native.render.mockRejectedValueOnce(syntaxError()).mockResolvedValue(good);
    const { renderMermaidDiagram } = await import("./mermaidRuntime");
    const copies = await Promise.all(
      Array.from({ length: 48 }, () => renderMermaidDiagram(fixture.source, "light")),
    );
    expect(native.render.mock.calls.map((call) => call[0])).toEqual([
      fixture.source,
      fixture.expected,
    ]);
    expect(copies.every((copy) => copy.recovery?.source === fixture.expected)).toBe(true);
    expect(copies[0]?.recovery?.originalSource).toBe(fixture.source);
    expect(new Set(copies.map((copy) => copy.svg)).size).toBe(48);
    await renderMermaidDiagram(fixture.source, "light");
    expect(native.render).toHaveBeenCalledTimes(2);
  });
  it.each([
    { name: "syntax", failure: syntaxError() },
    { name: "layout", failure: new Error("Layout failed") },
    { name: "invalid-svg", failure: null },
  ])("rolls back the entire candidate when rendering fails ($name)", async ({ name, failure }) => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const source = scenarioSource(`rollback-${name}`);
    const original = syntaxError();
    native.render.mockRejectedValueOnce(original);
    if (failure) native.render.mockRejectedValueOnce(failure);
    else native.render.mockResolvedValueOnce({ ...good, svg: "invalid SVG" });
    const { renderMermaidDiagram } = await import("./mermaidRuntime");
    await expect(renderMermaidDiagram(source, "light")).rejects.toMatchObject({
      cause: original,
      details: original.message,
    });
    expect(native.render).toHaveBeenCalledTimes(2);
    // Failed candidates are not successes in cache and do not poison the queue.
    native.render.mockResolvedValue(good);
    const result = await renderMermaidDiagram(source, "light");
    expect(result.recovery).toBeUndefined();
    expect(native.render).toHaveBeenCalledTimes(3);
  });
  it("does not plan/rewrite successfully rendered source even when a rule could match", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    native.render.mockResolvedValue(good);
    const { renderMermaidDiagram } = await import("./mermaidRuntime");
    const source = scenarioSource("successful-original");
    expect((await renderMermaidDiagram(source, "light")).recovery).toBeUndefined();
    expect(native.render.mock.calls.map((call) => call[0])).toEqual([source]);
  });
  it("does not retry layout/resource failures and keeps theme caches separate", async () => {
    await using _fixture = _createFixture();
    await _setupFixture0(_fixture);

    const { renderMermaidDiagram } = await import("./mermaidRuntime");
    const source = scenarioSource("resource-failure-theme-cache");
    native.render.mockRejectedValueOnce(new Error("Maximum number of edges exceeded"));
    await expect(renderMermaidDiagram(source, "light")).rejects.toThrow("Maximum number");
    expect(native.render).toHaveBeenCalledTimes(1);
    native.render.mockResolvedValue(good);
    await renderMermaidDiagram(source, "dark");
    expect(native.render).toHaveBeenCalledTimes(2);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
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
