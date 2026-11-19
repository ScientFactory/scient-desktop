import { describe, expect, it, vi } from "vite-plus/test";

import { createTiffPreviewSession } from "./tiffPreviewSession";

class SilentWorker {
  static created: SilentWorker[] = [];
  readonly terminate = vi.fn();
  readonly postMessage = vi.fn();
  constructor() {
    SilentWorker.created.push(this);
  }
  addEventListener() {}
}

describe("createTiffPreviewSession", () => {
  it("replaces a worker that runs past the deadline instead of leaving it decoding", async () => {
    SilentWorker.created = [];
    vi.stubGlobal("Worker", SilentWorker);
    vi.useFakeTimers();
    const session = createTiffPreviewSession();
    try {
      const first = session.decode("blob:slow", 0, new AbortController().signal);
      const rejected = expect(first).rejects.toThrow("took too long");
      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;
      expect(SilentWorker.created).toHaveLength(1);
      expect(SilentWorker.created[0]!.terminate).toHaveBeenCalledOnce();

      const second = session.decode("blob:slow", 1, new AbortController().signal);
      expect(SilentWorker.created).toHaveLength(2);
      expect(SilentWorker.created[1]!.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ src: "blob:slow", plane: 1 }),
        { transfer: [] },
      );
      session.dispose();
      await expect(second).rejects.toThrow("cancelled");
    } finally {
      session.dispose();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
