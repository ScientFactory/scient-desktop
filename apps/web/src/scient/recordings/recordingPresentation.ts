import { countStrongScripts } from "../bidi/contentDirection";

export function segmentDirection(
  text: string,
  language: string,
  previous?: "ltr" | "rtl",
  force?: "auto" | "ltr" | "rtl",
): "ltr" | "rtl" {
  if (force === "rtl" || force === "ltr") return force;
  const { rtl, ltr } = countStrongScripts(text);
  const ratio = rtl + ltr > 0 ? rtl / (rtl + ltr) : null;
  if (ratio !== null && ratio >= 0.45) return "rtl";
  if (ratio !== null && ratio <= 0.3) return "ltr";
  return previous ?? (/^(he|ar)(-|$)/i.test(language) ? "rtl" : "ltr");
}

export function recordingTime(seconds: number): string {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const remainder = String(whole % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`
    : `${minutes}:${remainder}`;
}

export function transcriptParagraphs(
  cues: readonly { text: string; start: number; end: number; speaker?: string | null }[],
  directions: readonly ("ltr" | "rtl")[],
  raw: boolean,
) {
  const paragraphs: { start: number; end: number; text: string; speaker?: string }[] = [];
  const texts: string[] = [];
  const rows: number[] = [];
  let speaker: string | undefined;
  for (const [index, cue] of cues.entries()) {
    const prefix = /^([\p{Lu}\p{Lo}][\p{Lu}\p{Lo} .'-]{1,39}):\s+/u.exec(cue.text);
    const nextSpeaker = cue.speaker ?? prefix?.[1];
    const changed = nextSpeaker !== undefined && nextSpeaker !== speaker;
    speaker = nextSpeaker ?? speaker;
    const text = raw
      ? cue.text
      : cue.text
          .slice(prefix?.[0].length ?? 0)
          .replace(/\s+/gu, " ")
          .trim();
    const current = paragraphs.at(-1);
    if (
      raw ||
      !current ||
      changed ||
      directions[index] !== directions[index - 1] ||
      cue.start - cues[index - 1]!.end >= 1.8 ||
      cue.end - cues[current.start]!.start > 45 ||
      current.text.length + text.length > 400
    ) {
      paragraphs.push({
        start: index,
        end: index + 1,
        text,
        ...(speaker && !raw ? { speaker } : {}),
      });
    } else {
      current.end = index + 1;
      current.text += ` ${text}`;
    }
    rows.push(paragraphs.length - 1);
    texts.push(text);
  }
  return { paragraphs, texts, rows };
}

export function captureElapsed(
  clock: { elapsed: number; started: number | undefined },
  now: number,
) {
  return clock.elapsed + (clock.started === undefined ? 0 : now - clock.started);
}
