import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { MathPreviewRequest } from "./mathReadingPreviewProtocol";

// These tests exercise worker ownership and cancellation, not formula layout.
vi.mock("mathlive", () => ({
  validateLatex: () => [],
  MathfieldElement: class {
    macros = {};
  },
}));

class PreviewWorker extends EventTarget {
  static instances: PreviewWorker[] = [];
  messages: MathPreviewRequest[] = [];
  terminated = false;
  constructor() {
    super();
    PreviewWorker.instances.push(this);
  }
  postMessage(message: MathPreviewRequest) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  PreviewWorker.instances = [];
  vi.stubGlobal("Worker", PreviewWorker);
  vi.stubGlobal("document", {
    createElement: () => ({ append() {}, remove() {}, style: {} }),
    body: { append() {} },
  });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("resumes queued formulas immediately when the active formula loses its last subscriber", async () => {
  const { mathReadingPreview } = await import("./mathReadingPreview");
  const obsolete = vi.fn();
  const current = vi.fn();
  const cancelFirst = mathReadingPreview("first", false, {}, undefined, obsolete);
  const first = PreviewWorker.instances[0]!;
  first.receive({ ready: true });
  const firstRequest = first.messages[0]!;
  const cancelSecond = mathReadingPreview("second", false, {}, undefined, current);

  // The first worker may be stuck in synchronous macro expansion. Cancellation
  // must release the remaining formulas without waiting for its timeout.
  cancelFirst();
  expect(first.terminated).toBe(true);
  expect(PreviewWorker.instances).toHaveLength(2);
  const replacement = PreviewWorker.instances[1]!;
  replacement.receive({ ready: true });
  const secondRequest = replacement.messages[0]!;
  expect(secondRequest.source).toBe("second");
  first.receive({ id: firstRequest.id, markup: "obsolete result" });
  expect(current).not.toHaveBeenCalled();
  replacement.receive({ id: secondRequest.id, markup: "current result" });
  expect(current).toHaveBeenCalledExactlyOnceWith("current result");
  expect(obsolete).not.toHaveBeenCalled();
  cancelSecond();
});

it("keeps shared active work when one subscriber or an unrelated queued view is canceled", async () => {
  const { mathReadingPreview } = await import("./mathReadingPreview");
  const discarded = vi.fn();
  const retained = vi.fn();
  const queued = vi.fn();
  const macros = {};
  const cancelFirst = mathReadingPreview("shared", false, macros, undefined, discarded);
  const worker = PreviewWorker.instances[0]!;
  worker.receive({ ready: true });
  const request = worker.messages[0]!;
  const cancelShared = mathReadingPreview("shared", false, macros, undefined, retained);
  const cancelQueued = mathReadingPreview("queued", false, macros, undefined, queued);
  cancelFirst();
  cancelQueued();
  expect(worker.terminated).toBe(false);
  expect(PreviewWorker.instances).toHaveLength(1);
  worker.receive({ id: request.id, markup: "shared result" });
  expect(retained).toHaveBeenCalledExactlyOnceWith("shared result");
  expect(discarded).not.toHaveBeenCalled();
  expect(queued).not.toHaveBeenCalled();
  cancelShared();
});

it("does not remove a newer retry when a failed conversion's remaining view is canceled", async () => {
  const { mathReadingPreview } = await import("./mathReadingPreview");
  const firstRetry = vi.fn();
  const secondRetry = vi.fn();
  const canceled = vi.fn();
  const macros = {};
  let cancelOther = () => {};
  let cancelFirstRetry = () => {};
  let cancelSecondRetry = () => {};
  const cancelInitial = mathReadingPreview("retry", false, macros, undefined, (markup) => {
    if (markup !== null) return;
    cancelFirstRetry = mathReadingPreview("retry", false, macros, undefined, firstRetry);
    cancelOther();
    cancelSecondRetry = mathReadingPreview("retry", false, macros, undefined, secondRetry);
  });
  const worker = PreviewWorker.instances[0]!;
  worker.receive({ ready: true });
  cancelOther = mathReadingPreview("retry", false, macros, undefined, canceled);
  worker.receive({ id: worker.messages[0]!.id, markup: null });
  worker.receive({ id: worker.messages[1]!.id, markup: "retry result" });
  expect(firstRetry).toHaveBeenCalledExactlyOnceWith("retry result");
  expect(secondRetry).toHaveBeenCalledExactlyOnceWith("retry result");
  expect(canceled).not.toHaveBeenCalled();
  expect(worker.messages).toHaveLength(2);
  cancelInitial();
  cancelFirstRetry();
  cancelSecondRetry();
});

it("keeps recently read markup when background scanning exceeds the cache budget", async () => {
  const { mathReadingPreview, retainMathReadingPreview } = await import("./mathReadingPreview");
  const macros = {};
  const complete = vi.fn();
  mathReadingPreview("reading", false, macros, undefined, complete, () => 0);
  const worker = PreviewWorker.instances[0]!;
  worker.receive({ ready: true });
  worker.receive({ id: worker.messages.at(-1)!.id, markup: "ready reading" });
  // Visit an already-rendered background result without reconstructing its view.
  retainMathReadingPreview("reading", false, macros, undefined, "ready reading");
  for (let i = 0; i < 520; i++) {
    mathReadingPreview(
      `background-${i}`,
      false,
      macros,
      undefined,
      () => {},
      () => 0,
    );
    worker.receive({ id: worker.messages.at(-1)!.id, markup: `ready background-${i}` });
  }
  const before = worker.messages.length;
  mathReadingPreview("reading", false, macros, undefined, complete, () => 2);
  expect(complete).toHaveBeenLastCalledWith("ready reading", true);
  expect(worker.messages).toHaveLength(before);
  const evicted = vi.fn();
  const cancel = mathReadingPreview("background-0", false, macros, undefined, evicted);
  expect(evicted).not.toHaveBeenCalled();
  expect(worker.messages).toHaveLength(before + 1);
  cancel();
});
