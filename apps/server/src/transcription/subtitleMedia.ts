// @effect-diagnostics nodeBuiltinImport:off - Shares the media pipeline's Promise process boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { openZipArchive } from "../zipArchive.ts";
import {
  parseAss,
  parseSrt,
  parseTeamsDocument,
  parseVtt,
  parseZoomVtt,
} from "./subtitleParsers.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export class MediaToolUnavailable extends Schema.TaggedError<MediaToolUnavailable>()(
  "MediaToolUnavailable",
  { message: Schema.String },
) {}

export async function runMediaTool(
  command: string,
  args: string[],
  options: { signal: AbortSignal; maxBuffer?: number },
) {
  try {
    return await execFile(command, args, options);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "EACCES")
    ) {
      throw new MediaToolUnavailable({
        message: `The server could not run ${NodePath.basename(command)}. Install or configure the media tool.`,
      });
    }
    throw error;
  }
}

const codecs = new Set(["mov_text", "subrip", "ass", "ssa", "webvtt"]);

export type SubtitleInput =
  | { stream: number }
  | { file: string; format?: "zoom-vtt" | "teams-docx"; language?: string };

export async function probeSubtitles(source: string, signal: AbortSignal, ffmpeg = "ffmpeg") {
  const sibling = NodePath.join(
    NodePath.dirname(ffmpeg),
    NodePath.extname(ffmpeg).toLowerCase() === ".exe" ? "ffprobe.exe" : "ffprobe",
  );
  const command =
    NodePath.isAbsolute(ffmpeg) &&
    (await NodeFSP.stat(sibling).then(
      (entry) => entry.isFile(),
      () => false,
    ))
      ? sibling
      : "ffprobe";
  const { stdout } = await runMediaTool(
    command,
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      source,
    ],
    { signal, maxBuffer: 16 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: {
      index: number;
      codec_type: string;
      codec_name?: string;
      closed_captions?: number;
      tags?: { language?: string; title?: string; handler_name?: string };
      disposition?: { forced?: number; default?: number; hearing_impaired?: number };
    }[];
  };
  const stem = NodePath.basename(source, NodePath.extname(source));
  const sidecars = (
    await NodeFSP.readdir(NodePath.dirname(source), { withFileTypes: true })
  ).flatMap((entry) => {
    const extension = NodePath.extname(entry.name);
    const name = NodePath.basename(entry.name, extension);
    if (!entry.isFile() || !/^\.(srt|vtt|ass|ssa)$/i.test(extension)) return [];
    if (name !== stem && !name.startsWith(stem + ".")) return [];
    const suffix = name.slice(stem.length + 1);
    const labels = suffix.split(".").map((label) => label.toLowerCase());
    const auto = labels.includes("auto") || labels.includes("asr");
    const hearingImpaired = labels.includes("sdh") || labels.includes("cc");
    const forced = labels.includes("forced");
    const language = labels
      .filter((label) => !/^(auto|asr|sdh|cc|forced|orig)$/i.test(label))
      .join(".");
    if (language && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) return [];
    return [
      {
        file: NodePath.join(NodePath.dirname(source), entry.name),
        language: language || undefined,
        auto,
        hearingImpaired,
        forced,
      },
    ];
  });
  return {
    duration: Number(data.format?.duration),
    sidecars,
    tracks: (data.streams ?? [])
      .filter((track) => track.codec_type === "subtitle" || track.closed_captions)
      .map((track) => ({
        stream: track.index,
        codec: track.codec_type === "subtitle" ? track.codec_name : "embedded-closed-captions",
        supported: track.codec_type === "subtitle" && codecs.has(track.codec_name ?? ""),
        language: track.tags?.language,
        title: track.tags?.title ?? track.tags?.handler_name,
        forced: track.disposition?.forced === 1,
        default: track.disposition?.default === 1,
        hearingImpaired: track.disposition?.hearing_impaired === 1,
        kind:
          track.codec_type !== "subtitle" || /(?:eia|cea)_?[67]08/.test(track.codec_name ?? "")
            ? "closed-caption"
            : /(?:hdmv_pgs|dvd|dvb)_subtitle/.test(track.codec_name ?? "")
              ? "bitmap"
              : codecs.has(track.codec_name ?? "")
                ? "text"
                : "unknown",
      })),
  };
}

export async function readSubtitles(
  source: string | null,
  selection: SubtitleInput,
  ffmpeg: string,
  signal: AbortSignal,
) {
  const probe = source
    ? await probeSubtitles(source, signal, ffmpeg)
    : { duration: Infinity, tracks: [], sidecars: [] };
  const options = { signal, maxBuffer: 16 * 1024 * 1024 };
  if ("stream" in selection) {
    if (!source) throw new Error("Select media for an embedded subtitle track.");
    const track = probe.tracks.find((candidate) => candidate.stream === selection.stream);
    if (!track?.supported) throw new SubtitleInputError({ detail: "Unsupported subtitle stream." });
    const format =
      track.codec === "ass" || track.codec === "ssa"
        ? "ass"
        : track.codec === "webvtt"
          ? "webvtt"
          : "srt";
    const { stdout } = await runMediaTool(
      ffmpeg,
      [
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        source,
        "-map",
        "0:" + track.stream,
        "-f",
        format,
        "pipe:1",
      ],
      options,
    );
    return {
      cues:
        format === "ass"
          ? parseAss(stdout)
          : format === "webvtt"
            ? parseVtt(stdout)
            : parseSrt(stdout),
      duration: probe.duration,
      language: track.language,
      forced: track.forced,
      title: track.title,
      hearingImpaired: track.hearingImpaired,
    };
  }
  const file = await NodeFSP.realpath(selection.file);
  const format = selection.format ?? NodePath.extname(file).toLowerCase();
  const sidecar = probe.sidecars.find((entry) => entry.file === file);
  const language = selection.language ?? sidecar?.language;
  const parse = {
    ".srt": parseSrt,
    ".vtt": parseVtt,
    ".ass": parseAss,
    ".ssa": parseAss,
    "zoom-vtt": parseZoomVtt,
  };
  const handle = await NodeFSP.open(
    file,
    NodeFSP.constants.O_RDONLY | NodeFSP.constants.O_NOFOLLOW | NodeFSP.constants.O_NONBLOCK,
  );
  let bytes: Buffer;
  let input: { size: number; mtimeMs: number; hash: string };
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > options.maxBuffer)
      throw new SubtitleInputError({ detail: "Invalid subtitle file." });
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const current = await handle.stat();
    if (offset !== info.size || current.mtimeMs !== info.mtimeMs || current.size !== info.size)
      throw new SubtitleInputError({ detail: "Subtitle file changed while reading." });
    bytes = buffer.subarray(0, offset);
    input = {
      size: current.size,
      mtimeMs: current.mtimeMs,
      hash: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await handle.close();
  }
  const document = format === "teams-docx" || format === ".docx";
  const parser = Object.entries(parse).find(([key]) => key === format)?.[1];
  if (!document && !parser) throw new SubtitleInputError({ detail: "Unsupported subtitle file." });
  const cues = document
    ? parseTeamsDocument(
        await Effect.runPromise(Effect.scoped(readTeamsXml(bytes, options.maxBuffer, signal)), {
          signal,
        }),
        probe.duration,
      )
    : parser!(bytes.toString("utf8"));
  return {
    cues,
    file,
    input,
    language,
    imported: document || format === "zoom-vtt",
    auto: sidecar?.auto,
    forced: sidecar?.forced,
    hearingImpaired: sidecar?.hearingImpaired,
  };
}

export class SubtitleInputError extends Schema.TaggedError<SubtitleInputError>()(
  "SubtitleInputError",
  {
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
const readTeamsXml = Effect.fn("Transcription.readTeamsXml")(function* (
  bytes: Buffer,
  limit: number,
  signal: AbortSignal,
) {
  const archive = yield* openZipArchive(
    bytes,
    (detail, cause) => new SubtitleInputError({ detail, cause }),
  );
  if (archive.entryCount > 10_000)
    return yield* new SubtitleInputError({
      detail: "Teams document has too many archive entries.",
    });
  for (let entry = yield* archive.next; entry; entry = yield* archive.next) {
    if (entry.fileName !== "word/document.xml") continue;
    if (entry.uncompressedSize > limit)
      return yield* new SubtitleInputError({ detail: "Teams document is too large." });
    const stream = yield* archive.streamEntry(entry);
    return yield* Effect.tryPromise({
      catch: (cause) => new SubtitleInputError({ detail: "Could not read Teams document.", cause }),
      try: async () => {
        const blocks: Buffer[] = [];
        let size = 0;
        for await (const chunk of stream) {
          signal.throwIfAborted();
          const block = Buffer.from(chunk);
          size += block.length;
          if (size > limit) throw new Error("Teams document is too large.");
          blocks.push(block);
        }
        return Buffer.concat(blocks).toString("utf8");
      },
    });
  }
  return yield* new SubtitleInputError({ detail: "Teams document has no main document part." });
});
