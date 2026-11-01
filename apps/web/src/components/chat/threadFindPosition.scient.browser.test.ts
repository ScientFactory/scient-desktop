import { describe, expect, it, vi } from "vite-plus/test";
import { readThreadFindPosition } from "./threadFindPosition";
async function _cleanupFixture0(_fixture: _Fixture) {
  await vi.restoreAllMocks();
}
function viewport(_fixture: _Fixture, text = "COD4 COD4") {
  const container = document.createElement("div");
  container.innerHTML = `<div data-timeline-row-id="above"><div data-thread-find-text>COD4</div></div>
    <div data-timeline-row-id="reading"><div data-thread-find-text>${text}</div></div>`;
  container.style.cssText =
    "position:fixed;left:0;top:100px;width:500px;height:400px;overflow:hidden";
  const above = container.children[0] as HTMLElement;
  above.style.cssText = "position:absolute;left:0;top:-100px;width:500px;height:80px";
  const reading = container.children[1] as HTMLElement;
  reading.style.cssText =
    "position:absolute;left:0;top:-50px;width:500px;height:300px;line-height:20px";
  if (text === "COD4 COD4")
    reading.firstElementChild!.innerHTML =
      '<span style="display:block;height:100px">COD4 </span><span style="display:block">COD4</span>';
  document.body.append(container);
  _fixture.stack.defer(() => container.remove());
  return container;
}
describe("reading position for find", () => {
  // regression: 12069eefd7 feat(web): find messages and plans in the current thread (#10439)
  it("skips earlier rows and occurrences above the viewport within the current message", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));
    const container = viewport(_fixture);
    expect(readThreadFindPosition(container, "COD4", (id) => id, 100)).toEqual({
      entryId: "reading",
      occurrence: 1,
    });
  });
  // regression: 12069eefd7 feat(web): find messages and plans in the current thread (#10439)
  it("starts after the current message when all its occurrences are above the viewport", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));
    const container = viewport(_fixture);
    container.querySelectorAll<HTMLElement>("span")[1]!.style.transform = "translateY(-100px)";
    expect(readThreadFindPosition(container, "COD4", (id) => id, 100)).toEqual({
      entryId: "reading",
      occurrence: 2,
    });
  });
  // regression: 12069eefd7 feat(web): find messages and plans in the current thread (#10439)
  it("anchors unmatched or folded content and excludes rows hidden behind the composer", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));
    const container = viewport(_fixture, "nothing");
    expect(readThreadFindPosition(container, "COD4", () => "folded-message", 100)).toEqual({
      entryId: "folded-message",
      occurrence: 0,
    });
    (container.children[1] as HTMLElement).style.top = "320px";
    expect(readThreadFindPosition(container, "COD4", (id) => id, 100)).toBeUndefined();
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
