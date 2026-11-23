// @effect-diagnostics nodeBuiltinImport:off - These fixtures exercise real files and the host media process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { openCloudEngine } from "./cloud.ts";
import { atomicWrite } from "./ledger.ts";
import { canResume, runJob, type Job } from "./job.ts";
import { fingerprint, openLedger } from "./ledger.ts";
import { frameSize, looksRepetitive, planWindows, sourceSeconds } from "./windows.ts";

async function* frames(silence: number, voiced: number) {
  for (let index = 0; index < silence + voiced; index++) {
    yield { pcm: new Float32Array(frameSize), speech: index >= silence };
  }
}

it("gates silence under every rule and maps trimmed timestamps to source samples", async () => {
  for (const rule of ["fixed", "meetily", "short"] as const) {
    expect(await Array.fromAsync(planWindows(frames(1_800, 0), rule))).toEqual([]);
  }
  const [window] = await Array.fromAsync(planWindows(frames(125, 40), "meetily"));
  expect(window).toBeDefined();
  expect(sourceSeconds(window!, 0.1)).toBeCloseTo(((125 - 6) * frameSize) / 16_000 + 0.1);
});

it("finds low diversity in Arabic and Hebrew without rewriting Unicode", () => {
  expect(looksRepetitive("مرحبا ".repeat(15))).toBe(true);
  expect(looksRepetitive("שלום ".repeat(15))).toBe(true);
  expect(looksRepetitive("שלום וברכה לכל המשתתפים בשיעור על שפות ומידע")).toBe(false);
});

it("commits a received cloud result during cancel and skips it after a torn ledger tail", async () => {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "scient-transcription-test-"),
  );
  try {
    const source = NodePath.join(directory, "fixture.wav");
    const result = NodeChildProcess.spawnSync("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=440:r=16000:d=16",
      source,
    ]);
    if (result.error || result.status !== 0)
      throw result.error ?? new Error(result.stderr.toString());
    const job: Job = {
      id: "test",
      source,
      input: await fingerprint(source),
      settings: {
        ffmpeg: "ffmpeg",
        decoderVersion: "fixture",
        engine: "compatible",
        accountName: "Fixture account",
        model: "fixture",
        language: "he",
        engineFingerprint: "fixture",
        rule: "short",
      },
    };
    const key = "synthetic-private-cloud-key";
    await atomicWrite(NodePath.join(directory, "job.json"), JSON.stringify(job));
    let calls = 0;
    const first = new AbortController();
    const run = (signal: AbortSignal, cancel?: () => void) =>
      runJob(
        directory,
        job,
        async (batch) => batch.map(() => 1),
        async () =>
          openCloudEngine(
            {
              endpoint: new URL("http://127.0.0.1/v1/audio/transcriptions"),
              provider: "compatible",
              model: "fixture",
              language: "he",
              maxAudioBytes: 1_000_000,
            },
            async () => key,
            signal,
            async () => {
              calls++;
              if (calls === 1) cancel?.();
              return Response.json({ text: "שלום, עולם " + key });
            },
          ),
        signal,
        () => {},
      );
    expect(await run(first.signal, () => first.abort())).toEqual({
      stage: "canceled",
      completed: 1,
    });
    const saved = await NodeFSP.readFile(NodePath.join(directory, "results.jsonl"), "utf8");
    await NodeFSP.appendFile(NodePath.join(directory, "results.jsonl"), '{"window');
    const state = await run(new AbortController().signal);
    expect(state).toEqual({ stage: "completed", completed: 2 });
    expect(calls).toBe(2);
    expect(
      (await NodeFSP.readFile(NodePath.join(directory, "results.jsonl"), "utf8")).startsWith(saved),
    ).toBe(true);
    expect((await openLedger(directory)).rows.map((row) => row.windowId)).toEqual([0, 1]);
    expect(await NodeFSP.readFile(NodePath.join(directory, "transcript.md"), "utf8")).toContain(
      "[0:00:00] שלום, עולם",
    );
    for (const name of ["job.json", "results.jsonl", "transcript.json", "transcript.md"]) {
      expect((await NodeFSP.readFile(NodePath.join(directory, name), "utf8")).includes(key)).toBe(
        false,
      );
    }
    expect(canResume(job, { ...job, settings: { ...job.settings, accountName: "Renamed" } })).toBe(
      true,
    );
    await NodeFSP.writeFile(source, "changed recording");
    expect(canResume(job, { ...job, input: await fingerprint(source) })).toBe(false);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("replays a torn ledger tail, skips committed windows and retains text on cancel", async () => {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "scient-transcription-test-"),
  );
  try {
    const source = NodePath.join(directory, "fixture.wav");
    const result = NodeChildProcess.spawnSync("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=440:r=16000:d=16",
      source,
    ]);
    if (result.error || result.status !== 0)
      throw result.error ?? new Error(result.stderr.toString());
    const job: Job = {
      id: "test",
      source,
      input: await fingerprint(source),
      correction: { mode: "off", notes: "Computational biology lecture", promptVersion: 2 },
      settings: {
        ffmpeg: "ffmpeg",
        decoderVersion: "fixture",
        engine: "local",
        model: "fixture",
        language: "he",
        engineFingerprint: "fixture",
        rule: "short",
      },
    };
    let calls = 0;
    const first = new AbortController();
    const run = (signal: AbortSignal, cancel?: () => void) =>
      runJob(
        directory,
        job,
        async (batch) => batch.map(() => 1),
        async () => ({
          supportsPrompt: true,
          async recognize(_pcm, _retry, hints) {
            expect(hints?.prompt).toBe("Computational biology lecture");
            calls++;
            if (calls === 2) cancel?.();
            return [{ text: "שלום, עולם" }];
          },
          async close() {},
        }),
        signal,
        () => {},
      );
    expect(await run(first.signal, () => first.abort())).toEqual({
      stage: "canceled",
      completed: 1,
    });
    const saved = await NodeFSP.readFile(NodePath.join(directory, "results.jsonl"), "utf8");
    await NodeFSP.appendFile(NodePath.join(directory, "results.jsonl"), '{"window');
    const state = await run(new AbortController().signal);
    expect(state).toEqual({ stage: "completed", completed: 2 });
    expect(calls).toBe(3);
    expect(
      (await NodeFSP.readFile(NodePath.join(directory, "results.jsonl"), "utf8")).startsWith(saved),
    ).toBe(true);
    expect((await openLedger(directory)).rows.map((row) => row.windowId)).toEqual([0, 1]);
    expect(await NodeFSP.readFile(NodePath.join(directory, "transcript.md"), "utf8")).toContain(
      "[0:00:00] שלום, עולם",
    );
    await NodeFSP.writeFile(source, "changed recording");
    expect(canResume(job, { ...job, input: await fingerprint(source) })).toBe(false);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("uses the quietest cut in the Meetily interval and retains the exact fixed EOF span", async () => {
  async function* audio() {
    for (let index = 0; index < 876; index++) {
      const pcm = new Float32Array(index === 875 ? 23 : frameSize);
      if (index < 790 || index > 792) pcm.fill(1);
      yield { pcm, speech: true };
    }
  }
  const meetily = await Array.fromAsync(planWindows(audio(), "meetily"));
  expect(meetily.map((window) => window.end)).toEqual([791 * frameSize, 875 * frameSize + 23]);
  const fixed = await Array.fromAsync(planWindows(audio(), "fixed"));
  expect(fixed.map((window) => [window.start, window.end])).toEqual([
    [0, 448_000],
    [448_000, 448_023],
  ]);
});
