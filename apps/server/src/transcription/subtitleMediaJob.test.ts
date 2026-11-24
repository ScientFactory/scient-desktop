// @effect-diagnostics nodeBuiltinImport:off - Exercises the media pipeline with disposable local files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { fingerprint } from "./ledger.ts";
import {
  MediaToolUnavailable,
  SubtitleInputError,
  probeSubtitles,
  readSubtitles,
  runMediaTool,
} from "./subtitleMedia.ts";
import { prepareSubtitles, publishSubtitles, salientTerms } from "./subtitleJob.ts";
import type { Job } from "./job.ts";

it("probes embedded metadata, loads a resolved sidecar, and publishes its aligned speaker turns", async () => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "subtitle-media-")),
  );
  try {
    const signal = AbortSignal.timeout(15_000);
    const source = NodePath.join(root, "lecture.mkv");
    const sidecar = NodePath.join(root, "lecture.he.sdh.vtt");
    const symlink = NodePath.join(root, "input.vtt");
    await NodeFSP.writeFile(sidecar, "WEBVTT\n\n00:00.000 --> 00:02.000\n<v Ada>NumPy שלום</v>\n");
    await NodeFSP.symlink(sidecar, symlink);
    await runMediaTool(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=5",
        "-i",
        sidecar,
        "-c:a",
        "pcm_s16le",
        "-c:s",
        "srt",
        "-metadata:s:s:0",
        "language=heb",
        "-disposition:s:0",
        "forced",
        source,
      ],
      { signal },
    );
    const found = await probeSubtitles(source, signal);
    await expect(readSubtitles(source, { stream: 99 }, "ffmpeg", signal)).rejects.toBeInstanceOf(
      SubtitleInputError,
    );
    const probeFixture = NodePath.join(root, "ffprobe");
    await NodeFSP.writeFile(
      probeFixture,
      `#!/bin/sh
printf '%s' '{"streams":[{"index":3,"codec_type":"subtitle","codec_name":"cea_708"},{"index":4,"codec_type":"subtitle","codec_name":"eia_608"}]}'
`,
      { mode: 0o700 },
    );
    const closed = await probeSubtitles(source, signal, NodePath.join(root, "ffmpeg"));
    expect(closed.tracks).toMatchObject([
      { codec: "cea_708", kind: "closed-caption", supported: false },
      { codec: "eia_608", kind: "closed-caption", supported: false },
    ]);
    await NodeFSP.unlink(probeFixture);

    expect(found.sidecars).toContainEqual({
      file: sidecar,
      language: "he",
      auto: false,
      hearingImpaired: true,
      forced: false,
    });
    expect(found.tracks[0]).toMatchObject({
      language: "heb",
      forced: true,
      kind: "text",
      supported: true,
    });
    expect(
      (await readSubtitles(source, { stream: found.tracks[0]!.stream }, "ffmpeg", signal)).cues,
    ).toHaveLength(1);
    const fixture = (name: string) =>
      NodeURL.fileURLToPath(new URL("./fixtures/subtitles/" + name, import.meta.url));
    const document = await readSubtitles(source, { file: fixture("teams.docx") }, "ffmpeg", signal);
    expect(document.cues[0]).toMatchObject({ speaker: "ליאורה", text: "שלום & مرحبا" });
    await expect(
      readSubtitles(source, { file: fixture("oversize.docx") }, "ffmpeg", signal),
    ).rejects.toMatchObject({ detail: "Teams document is too large." });
    const job: Job = {
      id: "test",
      source,
      input: await fingerprint(source),
      settings: {
        engine: "subtitles",
        model: "",
        ffmpeg: "ffmpeg",
        language: "auto",
        decoderVersion: "",
        engineFingerprint: "",
        rule: "fixed",
      },
    };
    const prepared = await prepareSubtitles(
      job,
      { file: symlink },
      async (batch) => batch.map(() => 1),
      signal,
    );
    expect(prepared.provenance).toMatchObject({
      language: "he",
      hearingImpaired: true,
      quality: null,
      selection: { file: sidecar },
    });
    await publishSubtitles(root, job, prepared);
    expect(await NodeFSP.readFile(NodePath.join(root, "transcript.md"), "utf8")).toContain(
      "Ada: NumPy שלום",
    );
    const transcript = JSON.parse(
      await NodeFSP.readFile(NodePath.join(root, "transcript.json"), "utf8"),
    );
    expect(transcript.subtitles).toMatchObject({ language: "he" });
    const ledger = JSON.parse(
      (await NodeFSP.readFile(NodePath.join(root, "results.jsonl"), "utf8")).trim(),
    );
    expect(ledger.segments[0]).toMatchObject({
      speaker: "Ada",
      language: "he",
      source: "subtitles",
    });
    expect(salientTerms([{ text: "Welcome everyone today" }, ...prepared.cues])).toEqual(["NumPy"]);
    await expect(
      runMediaTool(NodePath.join(root, "missing-ffprobe"), [], { signal }),
    ).rejects.toBeInstanceOf(MediaToolUnavailable);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("assesses an oversized first cue using bounded audio chunks", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "long-subtitle-turn-"));
  try {
    const source = NodePath.join(directory, "talk.wav");
    const file = NodePath.join(directory, "talk.en.vtt");
    const signal = AbortSignal.timeout(15_000);
    const text = ["speech ".repeat(90), "speech ".repeat(90)];
    await NodeFSP.writeFile(file, "WEBVTT\n\n00:00.000 --> 00:31.000\n" + text.join(""));
    await runMediaTool("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=31", source], {
      signal,
    });
    const job: Job = {
      id: "test",
      source,
      input: await fingerprint(source),
      settings: {
        engine: "local",
        model: "fixture",
        ffmpeg: "ffmpeg",
        language: "en",
        decoderVersion: "",
        engineFingerprint: "",
        rule: "fixed",
      },
    };
    const chunks: number[] = [];
    const result = await prepareSubtitles(
      job,
      { file },
      async (batch) => batch.map(() => 1),
      signal,
      async () => ({
        async recognize(pcm) {
          chunks.push(pcm.length / 16_000);
          return [{ text: text[chunks.length - 1]!, language: "en" }];
        },
        async close() {},
      }),
    );
    expect(chunks).toEqual([25, 6]);
    expect(result.provenance.assessment?.windows).toEqual([{ start: 0, end: 31 }]);
    expect(result.provenance.quality).toMatchObject({ evaluatedWords: 180, wordErrorRate: 0 });
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("retains acronyms and short multilingual technical terms while dropping function words", () => {
  expect(salientTerms([{ text: "MIT DNA SQL GPU AI with של מסד في جين" }])).toEqual(
    expect.arrayContaining(["MIT", "DNA", "SQL", "GPU", "AI", "מסד", "جين"]),
  );
  expect(salientTerms([{ text: "with של في" }])).toEqual([]);
});
