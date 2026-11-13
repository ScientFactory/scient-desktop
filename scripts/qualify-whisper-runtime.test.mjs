import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import { describe, expect, it } from "vite-plus/test";

import {
  EXPECTED_PHRASE,
  normalizeTranscript,
  QUALIFICATION_MODEL,
  QUALIFICATION_RECORDING,
  traceRuntime,
} from "./qualify-whisper-runtime.mjs";
import { WHISPER_CPP_COMMIT } from "./stage-whisper-runtime.ts";

describe("qualify-whisper-runtime", () => {
  it("pins the model and the recording", () => {
    expect(QUALIFICATION_MODEL.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(QUALIFICATION_RECORDING.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(QUALIFICATION_RECORDING.url).toContain(WHISPER_CPP_COMMIT);
  });

  it("compares words, not punctuation or case", () => {
    expect(
      normalizeTranscript(
        " And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.",
      ),
    ).toContain(EXPECTED_PHRASE);
    expect(normalizeTranscript("Ask not!\n  What your-country")).toBe("ask not what your country");
  });

  it("explains a failed transcription with its phases, stop, exit and the end of the server's output", async () => {
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      pid: 42,
      stdout: new NodeStream.PassThrough(),
      stderr: new NodeStream.PassThrough(),
      // The server leaves on the next turn, after the request has already failed.
      kill: (signal) => setImmediate(() => child.emit("exit", null, signal ?? "SIGTERM")),
    });
    const trace = traceRuntime({
      spawn: () => child,
      fetch: async (_url, init) => {
        if (init?.method === "OPTIONS") return new Response(null, { status: 200 });
        if (init?.method === "PUT") return new Response("{", { status: 200 });
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });
    trace.spawn("whisper-server", [], {});
    child.stderr.write("x".repeat(9000));
    child.stderr.write("whisper_init: model loaded\n");
    const endpoint = "http://127.0.0.1:1/scient-secret/inference";
    await trace.fetch(endpoint, { method: "OPTIONS" });
    // Headers arrive, then the body fails: the original error still reaches the runtime.
    const response = await trace.fetch(endpoint, { method: "PUT" });
    await expect(response.json()).rejects.toThrow(SyntaxError);
    await expect(trace.fetch(endpoint, { method: "POST" })).rejects.toThrow("aborted");
    child.kill();
    await trace.settled(5_000);

    const report = trace.report(45_000);
    expect(report).toMatch(/inference deadline 45 s/u);
    expect(report).toMatch(/spawned server \(pid 42\)/u);
    expect(report).toMatch(/OPTIONS inference: 200/u);
    expect(report).toMatch(/PUT inference body: SyntaxError/u);
    expect(report).toMatch(/POST inference: AbortError/u);
    expect(report).toMatch(
      /stop requested \(SIGTERM\)[^]*server exited \(code null, signal SIGTERM\)/u,
    );
    expect(report).toContain("whisper_init: model loaded");
    expect(report).not.toContain("x".repeat(8192));
    expect(report).not.toContain("scient-secret");
  });
});
