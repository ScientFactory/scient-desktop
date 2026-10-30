import {
  projectComputeOutputs,
  type ComputeOutput,
  type ComputeRepresentation,
} from "@scientfactory/compute";

/** What the agent reads back from a run: one text transcript plus the figures to attach. */
export interface ComputeTranscript {
  readonly text: string;
  readonly figures: ReadonlyArray<ComputeTranscriptFigure>;
}

export interface ComputeTranscriptFigure {
  readonly contentHash: string;
  readonly kind: "image" | "resource";
  readonly mediaType: string;
}

const MAXIMUM_TRANSCRIPT_CHARACTERS = 30_000;
const TRANSCRIPT_HEAD_CHARACTERS = 8_000;
const VIEWABLE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif"];
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/** Applies carriage returns and backspaces the way a terminal shows them, then drops colors. */
function terminalText(raw: string): string {
  return raw
    .replace(ANSI_ESCAPE, "")
    .split("\n")
    .map((line) => {
      const segments = line.replace(/\r$/, "").split("\r");
      let rendered = "";
      for (const segment of segments) {
        rendered = segment + rendered.slice(segment.length);
      }
      let withBackspaces = "";
      for (const character of rendered) {
        withBackspaces =
          character === "\b" ? withBackspaces.slice(0, -1) : withBackspaces + character;
      }
      return withBackspaces;
    })
    .join("\n");
}

function textOf(representation: ComputeRepresentation): string | null {
  const data = representation.data;
  return data._tag === "text" ? data.text : data._tag === "json" ? data.json : null;
}

function describeBundle(
  representations: ReadonlyArray<ComputeRepresentation>,
  figures: ComputeTranscriptFigure[],
): string {
  const byType = new Map(representations.map((entry) => [entry.mediaType, entry]));
  const image = VIEWABLE_IMAGE_TYPES.map((type) => byType.get(type)).find(Boolean);
  if (image?.data._tag === "resource") {
    figures.push({
      contentHash: image.data.contentHash,
      kind: "resource",
      mediaType: image.mediaType,
    });
    return `[figure ${figures.length}]`;
  }
  if (byType.has("application/vnd.plotly.v1+json"))
    return "[interactive Plotly figure, shown to the user]";
  if (byType.has("image/svg+xml")) return "[SVG figure, shown to the user]";
  const plain = byType.get("text/plain");
  if (plain !== undefined) return textOf(plain) ?? "";
  const markdown = byType.get("text/markdown") ?? byType.get("text/latex");
  if (markdown !== undefined) return textOf(markdown) ?? "";
  const html = byType.get("text/html");
  if (html !== undefined) {
    return (textOf(html) ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .trim();
  }
  return `[output: ${representations.map((entry) => entry.mediaType).join(", ")}]`;
}

function bounded(text: string): string {
  if (text.length <= MAXIMUM_TRANSCRIPT_CHARACTERS) return text;
  const tail = MAXIMUM_TRANSCRIPT_CHARACTERS - TRANSCRIPT_HEAD_CHARACTERS;
  const omitted = text.length - MAXIMUM_TRANSCRIPT_CHARACTERS;
  return `${text.slice(0, TRANSCRIPT_HEAD_CHARACTERS)}\n[… ${omitted} characters omitted …]\n${text.slice(-tail)}`;
}

export function computeTranscript(outputs: ReadonlyArray<ComputeOutput>): ComputeTranscript {
  const figures: ComputeTranscriptFigure[] = [];
  const parts: string[] = [];
  const pending: { stream: "stdout" | "stderr" | null; text: string } = { stream: null, text: "" };
  const flush = () => {
    const text = terminalText(pending.text).replace(/\n+$/, "");
    if (text.length > 0) parts.push(pending.stream === "stderr" ? `[stderr]\n${text}` : text);
    pending.stream = null;
    pending.text = "";
  };
  for (const output of projectComputeOutputs(outputs)) {
    if (output._tag === "stream") {
      if (pending.stream !== output.stream) flush();
      pending.stream = output.stream;
      pending.text += output.text;
      continue;
    }
    flush();
    switch (output._tag) {
      case "diagnostic": {
        const { errorName, message, traceback } = output.diagnostic;
        const trace = terminalText(traceback.join("\n")).trim();
        parts.push(trace.length > 0 ? trace : `${errorName}: ${message}`);
        break;
      }
      case "image":
        if (output.mediaType === "image/png") {
          figures.push({
            contentHash: output.contentHash,
            kind: "image",
            mediaType: output.mediaType,
          });
          parts.push(`[figure ${figures.length}]`);
        } else {
          parts.push("[SVG figure, shown to the user]");
        }
        break;
      case "representation":
        parts.push(describeBundle(output.bundle.representations, figures));
        break;
      case "system":
        if (output.event === "output-truncated") parts.push("[output truncated]");
        if (output.event === "session-restarted") parts.push("[session restarted]");
        break;
    }
  }
  flush();
  return { text: bounded(parts.filter((part) => part.length > 0).join("\n")), figures };
}
