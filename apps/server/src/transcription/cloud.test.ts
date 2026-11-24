import { expect, it, vi } from "vite-plus/test";
import { openCloudEngine } from "./cloud.ts";
import { frameSize, planWindows, sampleRate } from "./windows.ts";

it("limits planned windows by WAV bytes and duration", async () => {
  async function* frames() {
    for (let index = 0; index < 12; index++) {
      yield { pcm: new Float32Array(frameSize), speech: true };
    }
  }
  const windows = [];
  for await (const window of planWindows(frames(), "fixed", 44 + 5 * frameSize * 2)) {
    windows.push([window.start, window.end]);
  }
  expect(windows).toEqual([
    [0, 5 * frameSize],
    [5 * frameSize, 10 * frameSize],
    [10 * frameSize, 12 * frameSize],
  ]);
});

it("retries rate limits and emits only window bounds with the key removed", async () => {
  vi.useFakeTimers();
  try {
    const key = "synthetic-credential";
    const endpoint = new URL("http://127.0.0.1/v1/audio/transcriptions");
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(Response.json({ text: "hello " + key, words: [{ start: 0.1 }] }));
    const engine = openCloudEngine(
      {
        endpoint,
        provider: "compatible",
        model: "test",
        language: "en",
        maxAudioBytes: 33_000,
      },
      async () => key,
      new AbortController().signal,
      request,
    );
    const pending = engine.recognize(new Float32Array(sampleRate), false);
    await vi.advanceTimersByTimeAsync(1999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual([{ start: 0, end: 1, text: "hello [redacted]" }]);
    const body = request.mock.calls[1]?.[1]?.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("file")).toMatchObject({ size: 32_044 });
  } finally {
    vi.useRealTimers();
  }
});

it("cancels pending rate-limit backoff without sending another request", async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "20" } }));
    const engine = openCloudEngine(
      {
        endpoint: new URL("http://127.0.0.1/v1/audio/transcriptions"),
        provider: "compatible",
        model: "test",
        language: "auto",
        maxAudioBytes: 33_000,
      },
      async () => "synthetic",
      controller.signal,
      request,
    );
    const pending = engine.recognize(new Float32Array(sampleRate), false);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("retries only classified failures and reports each retry", async () => {
  vi.useFakeTimers();
  try {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connect", { cause: { code: "ECONNREFUSED" } }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const onRetry = vi.fn(async () => {});
    const engine = openCloudEngine(
      {
        endpoint: new URL("http://127.0.0.1/v1/audio/transcriptions"),
        provider: "compatible",
        model: "test",
        language: "auto",
        maxAudioBytes: 33_000,
        onRetry,
      },
      async () => "synthetic",
      new AbortController().signal,
      request,
    );
    const first = expect(engine.recognize(new Float32Array(sampleRate), false)).rejects.toThrow();
    await vi.runAllTimersAsync();
    await first;
    expect(onRetry.mock.calls).toEqual([["connect"], ["server-error"]]);

    request.mockReset().mockResolvedValue(new Response(null, { status: 503 }));
    onRetry.mockClear();
    const serverError = expect(
      engine.recognize(new Float32Array(sampleRate), false),
    ).rejects.toThrow();
    await vi.runAllTimersAsync();
    await serverError;
    expect(request).toHaveBeenCalledTimes(2);

    for (const failure of [
      new TypeError("reset during response", { cause: { code: "ECONNRESET" } }),
      new DOMException("timed out", "TimeoutError"),
    ]) {
      request.mockReset().mockRejectedValue(failure);
      await expect(engine.recognize(new Float32Array(sampleRate), false)).rejects.toMatchObject({
        code: "recognition-failed",
      });
      expect(request).toHaveBeenCalledTimes(1);
    }
    request.mockReset().mockResolvedValue(new Response(null, { status: 429 }));
    await expect(engine.recognize(new Float32Array(sampleRate), false)).rejects.toMatchObject({
      _tag: "TranscriptionRateLimited",
    });
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("caps streamed response bytes and reports rejected keys without reading their body", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(256 * 1024));
            controller.close();
          },
        }),
      ),
    )
    .mockResolvedValueOnce(new Response("synthetic-secret", { status: 403 }));
  const engine = openCloudEngine(
    {
      endpoint: new URL("http://127.0.0.1/v1/audio/transcriptions"),
      provider: "compatible",
      model: "test",
      language: "auto",
      maxAudioBytes: 33_000,
    },
    async () => "synthetic-secret",
    new AbortController().signal,
    request,
  );
  for (const code of ["provider-response-too-large", "provider-key-rejected"]) {
    await expect(engine.recognize(new Float32Array(sampleRate), false)).rejects.toMatchObject({
      code,
    });
  }
  expect(request).toHaveBeenCalledTimes(2);
});
