const listCounters = {
  arabic: "decimal",
  alph: "lower-alpha",
  Alph: "upper-alpha",
  roman: "lower-roman",
  Roman: "upper-roman",
} as const;

/** Recognize enumitem's ordinary numbering options without executing label macros. */
export function parseLatexListOptions(source: string) {
  let start = 1;
  let resume = false;
  let label: string | null = null;
  const seen = new Set<string>();
  for (const option of source.split(",")) {
    const value = option.trim();
    if (!value && !source.trim()) continue;
    const key = value.split("=", 1)[0]!.trim();
    if (seen.has(key)) return null;
    seen.add(key);
    if (value === "resume") resume = true;
    else if (/^start\s*=\s*\d+$/u.test(value)) start = Number(value.split("=")[1]);
    else if (/^label\s*=/u.test(value)) {
      const raw = value.slice(value.indexOf("=") + 1).trim();
      label = raw.startsWith("{") && raw.endsWith("}") ? raw.slice(1, -1) : raw;
      if (!latexListLabelPresentation(label)) return null;
    } else return null;
  }
  if (!Number.isSafeInteger(start) || start < 1 || (resume && seen.has("start"))) return null;
  return { start, resume, label };
}

export function latexListLabelPresentation(label: string) {
  const match = /^([(\[]?)\\(arabic|alph|Alph|roman|Roman)\*([)\].:]?)$/u.exec(label);
  if (!match) return null;
  const counter = match[2] as keyof typeof listCounters;
  return { style: listCounters[counter], prefix: match[1]!, suffix: match[3]! };
}

export function latexListOptionsSource(
  original: string | null | undefined,
  start: number,
  resume: boolean,
): string | null {
  const parsed = parseLatexListOptions(original ?? "");
  if (!parsed) return null;
  if (parsed.start === start && parsed.resume === resume) return original ? `[${original}]` : "";
  const options = [
    ...(resume ? ["resume"] : start !== 1 ? [`start=${start}`] : []),
    ...(parsed.label ? [`label=${parsed.label}`] : []),
  ];
  return options.length ? `[${options.join(",")}]` : "";
}
