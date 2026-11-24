import { recordingTime } from "./recordingPresentation";

export type TranscriptFormat = "md" | "txt" | "srt" | "vtt";

type ExportCue = { start: number; end: number; text: string; speaker?: string | null };

function subtitleTime(seconds: number, separator: string) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const wholeSeconds = Math.floor(milliseconds / 1000) % 60;
  const fraction = String(milliseconds % 1000).padStart(3, "0");
  const clock = [hours, minutes, wholeSeconds].map((part) => String(part).padStart(2, "0"));
  return `${clock.join(":")}${separator}${fraction}`;
}

function cueText(cue: ExportCue) {
  return cue.speaker && !cue.text.startsWith(`${cue.speaker}:`)
    ? `${cue.speaker}: ${cue.text}`
    : cue.text;
}

export function formatTranscript(cues: readonly ExportCue[], format: TranscriptFormat): string {
  if (format === "txt" || format === "md") {
    return cues
      .map((cue) =>
        format === "md" ? `[${recordingTime(cue.start)}] ${cueText(cue)}` : cueText(cue),
      )
      .join("\n\n");
  }
  const separator = format === "srt" ? "," : ".";
  const body = cues
    .map((cue, index) => {
      const text = cueText(cue)
        .split(/\r?\n/u)
        .filter((line) => line.trim())
        .join("\n")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      return `${index + 1}\n${subtitleTime(cue.start, separator)} --> ${subtitleTime(cue.end, separator)}\n${text}`;
    })
    .join("\n\n");
  return `${format === "vtt" ? "WEBVTT\n\n" : ""}${body}\n`;
}
