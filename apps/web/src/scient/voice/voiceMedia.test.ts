import { describe, expect, it, vi } from "vite-plus/test";

import { acquireCurrentMicrophone } from "./voiceMedia.ts";

describe("acquireCurrentMicrophone", () => {
  it("stops a stream that resolves after the request was cancelled", async () => {
    let resolveStream!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveStream = resolve;
        }),
    );
    const stop = vi.fn();
    let current = true;
    const pending = acquireCurrentMicrophone({ getUserMedia }, () => current);
    current = false;
    resolveStream({ getTracks: () => [{ stop }] } as unknown as MediaStream);

    await expect(pending).resolves.toBeNull();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("returns a stream while the request is current", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    await expect(acquireCurrentMicrophone({ getUserMedia }, () => true)).resolves.toBe(stream);
  });
});
