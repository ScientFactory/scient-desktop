import type { ConnectorToolSummary } from "@t3tools/contracts";

export function toolDisplayName(tool: Pick<ConnectorToolSummary, "name" | "title">): string {
  if (tool.title?.trim()) return tool.title.trim();
  const words = tool.name
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .map((word) =>
      /^(pdf|url|id|ids|api|doi|html|json|xml|http|https)$/iu.test(word)
        ? word.toUpperCase()
        : /^[A-Z\d]{2,}$/u.test(word)
          ? word
          : word.toLowerCase(),
    );
  const name = words.join(" ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function toolMakesChanges(tool: ConnectorToolSummary): boolean {
  return tool.destructive === true || tool.readOnly === false;
}

export function toolSummary(description: string | undefined): string {
  const lead =
    (description ?? "").split(
      /(?:^|\s)(?:Args|Arguments|Parameters|Returns?|Examples?)\s*:/iu,
    )[0] ?? "";
  const text = lead
    .replace(/^\s*#+\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  const end = [...text.matchAll(/[.!?](?=\s|$)/gu)].find(
    (match) => !/\b(?:e\.g|i\.e|etc|vs|dr|mr|mrs)\.$/iu.test(text.slice(0, match.index + 1)),
  );
  const sentence = end ? text.slice(0, end.index + 1) : text;
  return sentence.length > 180 ? `${sentence.slice(0, 177).trimEnd()}…` : sentence;
}

function readableMarkdown(text: string): string {
  const lines = text.replace(/^\n+|\n+$/gu, "").split("\n");
  const indent = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => line.match(/^ */u)![0].length),
  );
  return lines
    .map((line) => line.slice(Number.isFinite(indent) ? indent : 0))
    .join("\n")
    .trim()
    .split("\n")
    .map((line) => {
      const enumeration = line.trim().match(/^((?:[\w]+:)?<[^>]+>)\s+-\s+(.+)$/u);
      return enumeration ? `- \`${enumeration[1]}\`: ${enumeration[2]}` : line;
    })
    .join("\n");
}

export function toolDescription(tool: ConnectorToolSummary): string {
  const description = tool.description?.trim() ?? "";
  const sections = description.split(
    /(?:^|\n)\s*(?:#{1,6}\s*)?(Args|Arguments|Parameters|Returns?)\s*:\s*/iu,
  );
  if (sections.length === 1 && tool.parameters === undefined) return readableMarkdown(description);
  const lead = readableMarkdown(sections[0] ?? "");
  const parsed: Array<{ name: string; type?: string; description: string }> = [];
  let returns = "";
  let unparsed = "";
  for (let i = 1; i < sections.length; i += 2) {
    const body = sections[i + 1] ?? "";
    if (/^returns?$/iu.test(sections[i]!)) {
      returns = readableMarkdown(body);
      continue;
    }
    let current: (typeof parsed)[number] | undefined;
    for (const line of body.split("\n")) {
      const match = line.match(/^\s*([\w-]+)\s*(?:\(([^)]+)\))?:\s+(.+)$/u);
      if (match) {
        current = {
          name: match[1]!,
          ...(match[2] ? { type: match[2] } : {}),
          description: match[3]!,
        };
        parsed.push(current);
      } else if (current) current.description += `\n${line.trim()}`;
      else unparsed += `${line}\n`;
    }
  }
  const parameters =
    tool.parameters?.map((parameter) => ({
      ...parameter,
      description:
        parameter.description ||
        parsed.find((item) => item.name === parameter.name)?.description ||
        "",
    })) ?? parsed;
  const parameterText = parameters
    .map((parameter) => {
      const metadata = [
        parameter.type,
        "required" in parameter ? (parameter.required ? "required" : "optional") : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      const body = readableMarkdown(parameter.description)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      return `- \`${parameter.name.replaceAll("`", "")}\`${metadata ? ` (${metadata})` : ""}\n\n${body}`;
    })
    .join("\n\n");
  return [
    lead,
    parameterText || unparsed.trim()
      ? `## Parameters\n\n${parameterText}\n\n${readableMarkdown(unparsed)}`.trim()
      : "",
    returns ? `## Returns\n\n${returns}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
