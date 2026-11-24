export type Cue = { start: number; end: number; text: string; speaker: string | null };

const normalize = (text: string) => text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

function seconds(value: string) {
  const parts = value.replace(",", ".").split(":").map(Number);
  return parts.reduce((time, part) => time * 60 + part, 0);
}

function xmlText(text: string) {
  return text.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|lrm|rlm);/gi,
    (entity, raw: string) => {
      const key = raw.toLowerCase();
      const named: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
        lrm: "\u200e",
        rlm: "\u200f",
      };
      if (!key.startsWith("#")) return named[key] ?? entity;
      const code = key.startsWith("#x") ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    },
  );
}

function timedBlocks(text: string, voiceTags: boolean) {
  return normalize(text)
    .split(/\n(?:[ \t]*\n)+/)
    .flatMap((block): Cue[] => {
      if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(block)) return [];
      const lines = block.split("\n");
      const index = lines.findIndex((line) => line.includes("-->"));
      const match = lines[index]?.match(
        /^\s*((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d{3})(?:\s|$)/,
      );
      if (!match) return [];
      const body = lines.slice(index + 1).join("\n");
      const times = { start: seconds(match[1]!), end: seconds(match[2]!) };
      const plain = (line: string) =>
        xmlText(
          line.replace(
            /<\/?(?:[biu]|font|c(?:\.[\w-]+)*|lang|ruby|rt)(?:\s[^>]*)?>|<\d{2}:\d{2}(?::\d{2})?\.\d{3}>/gi,
            "",
          ),
        ).trim();
      if (!voiceTags) return [{ ...times, text: plain(body), speaker: null }];
      let speaker: string | null = null;
      const runs = body.split(/(<v(?:\.[^\s>]+)*\s+[^>]+>|<\/v>)/gi);
      const entries: Cue[] = [];
      for (const run of runs) {
        const voice = run.match(/^<v(?:\.[^\s>]+)*\s+([^>]+)>$/i);
        if (voice) speaker = xmlText(voice[1]!.trim());
        else if (/^<\/v>$/i.test(run)) speaker = null;
        else {
          const text = plain(run);
          if (text) entries.push({ ...times, text, speaker });
        }
      }
      return entries.length ? entries : [{ ...times, text: "", speaker: null }];
    });
}

export const parseSrt = (text: string) => timedBlocks(text, false);
export const parseVtt = (text: string) => timedBlocks(text, true);

export function parseZoomVtt(text: string) {
  return parseVtt(text).map((cue) => {
    if (cue.speaker) return cue;
    const prefix = cue.text.match(/^([^:\n]{1,80}):([\s\S]+)$/);
    if (!prefix) return cue;
    const speaker = stripBidi(prefix[1]!).trim();
    const body = prefix[2]!.replace(/^[\s\u202c\u2069]+/, "");
    if (
      !body ||
      !isSpeakerName(speaker) ||
      /^(note|notes|warning|example|question|answer|chat|summary|action items?)$/i.test(speaker)
    )
      return cue;
    if (
      !/^[\s\u202c\u2069]/.test(prefix[2]!) &&
      !/\p{Script=Hebrew}|\p{Script=Arabic}/u.test(speaker)
    )
      return cue;
    return { ...cue, speaker, text: body };
  });
}

export function parseAss(text: string): Cue[] {
  let events = false;
  let columns = [
    "layer",
    "start",
    "end",
    "style",
    "name",
    "marginl",
    "marginr",
    "marginv",
    "effect",
    "text",
  ];
  const cues: Cue[] = [];
  for (const line of normalize(text).split("\n")) {
    if (line.startsWith("[")) events = /^\[events\]$/i.test(line.trim());
    if (!events) continue;
    const format = line.match(/^Format:\s*(.+)/i);
    if (format)
      columns = format[1]!
        .toLowerCase()
        .split(",")
        .map((field) => field.trim());
    const dialogue = line.match(/^Dialogue:\s*(.+)/i);
    if (!dialogue || columns.at(-1) !== "text") continue;
    const fields = dialogue[1]!.split(",");
    if (fields.length < columns.length) continue;
    const field = (name: string) => fields[columns.indexOf(name)]?.trim() ?? "";
    const start = field("start");
    const end = field("end");
    if (!/^\d+:\d{2}:\d{2}\.\d+$/.test(start) || !/^\d+:\d{2}:\d{2}\.\d+$/.test(end)) continue;
    cues.push({
      start: seconds(start),
      end: seconds(end),
      speaker: field("name") || field("actor") || null,
      text: fields
        .slice(columns.length - 1)
        .join(",")
        .replace(/\{[^}]*\}/g, "")
        .replace(/\\[Nn]/g, "\n")
        .replace(/\\h/g, " ")
        .trim(),
    });
  }
  return cues;
}

function stripBidi(text: string) {
  return text.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

function isSpeakerName(name: string) {
  const tokens = name.split(/\s+/);
  return (
    tokens.length <= 6 &&
    tokens.every(
      (token) =>
        /^[\p{Lu}\p{Lt}\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Han}\p{Script=Hangul}][\p{L}\p{M}.'’\-]*$/u.test(
          token,
        ) || /^(al|de|del|du|da|di|van|von)$/.test(token),
    )
  );
}

export function parseTeamsDocument(xml: string, duration: number): Cue[] {
  const cues: Cue[] = [];
  let priorParagraph = "";
  for (const paragraph of xml.matchAll(/<w:p(?:\s[^>]*?)?(?<!\/)>([\s\S]*?)<\/w:p>/g)) {
    const text = [
      ...paragraph[1]!.matchAll(
        /<w:t(?:\s[^>]*?)?(?<!\/)>([\s\S]*?)<\/w:t>|<w:(?:br|cr|tab)(?:\s[^>]*)?\/>/g,
      ),
    ]
      .map((run) =>
        run[1] === undefined ? (/^<w:tab/.test(run[0]) ? "\t" : "\n") : xmlText(run[1]),
      )
      .join("")
      .trim();
    const newline = text.indexOf("\n");
    const headerText = stripBidi(newline < 0 ? text : text.slice(0, newline)).trim();
    const body = newline < 0 ? "" : text.slice(newline + 1).trim();
    const header = headerText.match(
      /^(?:([\p{L}\p{M}][\p{L}\p{M}.'’ -]{0,63})\s+)?\[?((?:\d+:)?[0-5]?\d:[0-5]\d)\]?$/u,
    );
    const previous = cues.at(-1);
    if (
      header &&
      isSpeakerName(header[1]?.trim() || stripBidi(priorParagraph).trim()) &&
      (!previous || seconds(header[2]!) > previous.start) &&
      (!Number.isFinite(duration) || seconds(header[2]!) < duration)
    ) {
      const start = seconds(header[2]!);
      const name = header[1]?.trim();
      if (previous) {
        previous.end = start;
        if (name && priorParagraph)
          previous.text = [previous.text, priorParagraph].filter(Boolean).join("\n");
      }
      cues.push({
        start,
        end: Number.isFinite(duration) ? duration : start + 3,
        speaker: name || stripBidi(priorParagraph).trim() || null,
        text: body,
      });
      priorParagraph = "";
    } else if (text) {
      if (previous && priorParagraph)
        previous.text = [previous.text, priorParagraph].filter(Boolean).join("\n");
      priorParagraph = text;
    }
  }
  const last = cues.at(-1);
  if (last && priorParagraph) last.text = [last.text, priorParagraph].filter(Boolean).join("\n");
  return cues;
}
