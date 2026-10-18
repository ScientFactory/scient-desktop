// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { VisualProcessingReply, VisualProcessingRequest } from "./visualProcessingProtocol";
import { applyLatexVisualDocumentChange, projectLatexVisualDocument } from "./latexVisualDocument";

class ProcessingWorker {
  static instances: ProcessingWorker[] = [];
  readonly requests: VisualProcessingRequest[] = [];
  readonly listeners = new Map<string, EventListener[]>();
  terminated = false;
  constructor() {
    ProcessingWorker.instances.push(this);
  }
  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  postMessage(request: VisualProcessingRequest) {
    this.requests.push(request);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: VisualProcessingReply | { ready: true }) {
    for (const listener of this.listeners.get("message") ?? [])
      listener(new MessageEvent("message", { data }));
  }
}

beforeEach(() => {
  // The client owns a module-level worker/queue. Each case imports it only
  // after resetting that singleton and installing this case's worker host.
  vi.resetModules();
  vi.useFakeTimers();
  ProcessingWorker.instances = [];
  vi.stubGlobal("Worker", ProcessingWorker);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("visual processing ownership and scheduling", () => {
  it("keeps a superseded typing worker warm without delivering its abandoned result", async () => {
    const { processVisualDocument } = await import("./visualProcessing");
    const abandoned = vi.fn(),
      next = vi.fn();
    const cancel = processVisualDocument({ kind: "references", source: "Old" }, abandoned, {
      keepWorkerOnCancel: true,
    });
    const worker = ProcessingWorker.instances[0]!;
    worker.emit({ ready: true });
    cancel();
    processVisualDocument({ kind: "references", source: "Current" }, next);
    expect(worker.terminated).toBe(false);
    worker.emit({ id: worker.requests[0]!.id, output: null });
    expect(abandoned).not.toHaveBeenCalled();
    expect(worker.requests).toHaveLength(2);
    worker.emit({ id: worker.requests[1]!.id, output: null });
    expect(next).toHaveBeenCalledExactlyOnceWith(null);
    expect(ProcessingWorker.instances).toHaveLength(1);
  });
  it("still bounds a cancelled warm job by the existing deadline", async () => {
    const { processVisualDocument } = await import("./visualProcessing");
    const abandoned = vi.fn();
    const cancel = processVisualDocument({ kind: "references", source: "Old" }, abandoned, {
      keepWorkerOnCancel: true,
    });
    const worker = ProcessingWorker.instances[0]!;
    worker.emit({ ready: true });
    cancel();
    await vi.advanceTimersByTimeAsync(3001);
    expect(worker.terminated).toBe(true);
    expect(abandoned).not.toHaveBeenCalled();
  });
  it("retains the submitted block identities across a structured-clone reply", async () => {
    const { processVisualDocument } = await import("./visualProcessing");
    const source = "First.\n\nLast.",
      projection = projectLatexVisualDocument(source);
    const content = {
      ...projection.content,
      content: [
        projection.content.content![0]!,
        { type: "paragraph", content: [{ type: "text", text: "Changed." }] },
      ],
    };
    processVisualDocument(
      {
        kind: "change",
        source,
        snapshotId: "first",
        setupSource: source,
        projection,
        content,
        rootSource: null,
        allowRootUpdates: false,
      },
      () => {},
    );
    const worker = ProcessingWorker.instances[0]!;
    worker.emit({ ready: true });
    const change = applyLatexVisualDocumentChange(source, projection, content)!;
    expect(change.projection.content).toBe(content);
    const cloned = structuredClone(change);
    expect(cloned.projection.content.content![0]).not.toBe(content.content[0]);
    worker.emit({
      id: worker.requests[0]!.id,
      output: { kind: "change", snapshotId: "first", change: cloned, notices: [] },
      contentMatchesInput: true,
    });
    processVisualDocument(
      {
        kind: "change",
        source: cloned.source,
        snapshotId: "second",
        setupSource: cloned.source,
        projection: cloned.projection,
        content: {
          ...content,
          content: [
            content.content[0]!,
            { type: "paragraph", content: [{ type: "text", text: "Again." }] },
          ],
        },
        rootSource: null,
        allowRootUpdates: false,
      },
      () => {},
    );
    expect(worker.requests[1]!.input).toMatchObject({ kind: "change-delta", prefix: 1, suffix: 0 });
  });
  it("puts editing and opening ahead of queued background indexes", async () => {
    const { processVisualDocument } = await import("./visualProcessing");
    const source = "First.\n\nLast.",
      projection = projectLatexVisualDocument(source);
    processVisualDocument({ kind: "references", source }, () => {});
    processVisualDocument({ kind: "project", source, setupSource: source }, () => {});
    processVisualDocument(
      {
        kind: "change",
        source,
        snapshotId: "current",
        setupSource: source,
        projection,
        content: projection.content,
        rootSource: null,
        allowRootUpdates: false,
      },
      () => {},
    );
    const worker = ProcessingWorker.instances[0]!;
    worker.emit({ ready: true });
    expect(worker.requests[0]!.input.kind).toBe("change");
    worker.emit({ id: worker.requests[0]!.id, output: null });
    expect(worker.requests[1]!.input.kind).toBe("project");
    worker.emit({ id: worker.requests[1]!.id, output: null });
    expect(worker.requests[2]!.input.kind).toBe("references");
  });

  it("releases canceled active work and rejects replies from its old worker", async () => {
    const { processVisualDocument } = await import("./visualProcessing");
    const stale = vi.fn(),
      current = vi.fn();
    const cancel = processVisualDocument(
      { kind: "project", source: "Old", setupSource: "Old" },
      stale,
    );
    const old = ProcessingWorker.instances[0]!;
    old.emit({ ready: true });
    processVisualDocument({ kind: "project", source: "New", setupSource: "New" }, current);
    cancel();
    expect(old.terminated).toBe(true);
    const next = ProcessingWorker.instances[1]!;
    next.emit({ ready: true });
    old.emit({
      id: old.requests[0]!.id,
      output: { kind: "project", projection: projectLatexVisualDocument("Old") },
    });
    expect(stale).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    next.emit({
      id: next.requests[0]!.id,
      output: { kind: "project", projection: projectLatexVisualDocument("New") },
    });
    expect(current).toHaveBeenCalledOnce();
  });

  it("retries full input when the retained worker base was evicted", async () => {
    const { processVisualDocument } = await import("./visualProcessing");
    const source = "First.\n\nLast.",
      projection = projectLatexVisualDocument(source);
    processVisualDocument({ kind: "project", source, setupSource: source }, () => {});
    const worker = ProcessingWorker.instances[0]!;
    worker.emit({ ready: true });
    worker.emit({ id: worker.requests[0]!.id, output: { kind: "project", projection } });
    const complete = vi.fn();
    processVisualDocument(
      {
        kind: "change",
        source,
        snapshotId: "current",
        setupSource: source,
        projection,
        content: {
          ...projection.content,
          content: [projection.content.content![0]!, { type: "paragraph", content: [] }],
        },
        rootSource: null,
        allowRootUpdates: false,
      },
      complete,
    );
    const request = worker.requests[1]!;
    expect(request.input.kind).toBe("change-delta");
    worker.emit({ id: request.id, output: null, needsFull: true });
    expect(worker.requests[2]!.input.kind).toBe("change");
    expect(complete).not.toHaveBeenCalled();
    worker.emit({ id: request.id, output: null });
    expect(complete).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("rejects an obsolete snapshot reply even when the native bytes match again", async () => {
    const { processVisualDocument } = await import("./visualProcessing");
    const source = "Before.";
    const projection = projectLatexVisualDocument(source);
    const content = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Local." }] }],
    };
    const complete = vi.fn();
    processVisualDocument(
      {
        kind: "change",
        source,
        snapshotId: "A-after-B",
        setupSource: source,
        projection,
        content,
        rootSource: null,
        allowRootUpdates: false,
      },
      complete,
    );
    const worker = ProcessingWorker.instances[0]!;
    worker.emit({ ready: true });
    worker.emit({
      id: worker.requests[0]!.id,
      output: {
        kind: "change",
        snapshotId: "A-before-B",
        change: applyLatexVisualDocumentChange(source, projection, content),
        notices: [],
      },
    });
    expect(complete).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("continues serving the queue after a caller throws", async () => {
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    const { processVisualDocument } = await import("./visualProcessing");
    processVisualDocument({ kind: "references", source: "First" }, () => {
      throw new Error("Caller failed");
    });
    const next = vi.fn();
    processVisualDocument({ kind: "references", source: "Second" }, next);
    const worker = ProcessingWorker.instances[0]!;
    worker.emit({ ready: true });
    worker.emit({ id: worker.requests[0]!.id, output: null });
    expect(report).toHaveBeenCalledOnce();
    worker.emit({ id: worker.requests[1]!.id, output: null });
    expect(next).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("bounds active jobs and keeps an aborted caller from publishing", async () => {
    const { processVisualDocumentAsync } = await import("./visualProcessing");
    const controller = new AbortController();
    const result = processVisualDocumentAsync(
      { kind: "references", source: "Text" },
      controller.signal,
    );
    const worker = ProcessingWorker.instances[0]!;
    worker.emit({ ready: true });
    controller.abort();
    await expect(result).resolves.toBeNull();
    expect(worker.terminated).toBe(true);
    const next = processVisualDocumentAsync(
      { kind: "references", source: "Next" },
      new AbortController().signal,
    );
    ProcessingWorker.instances[1]!.emit({ ready: true });
    await vi.advanceTimersByTimeAsync(3001);
    await expect(next).resolves.toBeNull();
  });
});
