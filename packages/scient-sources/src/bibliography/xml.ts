export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: Array<XmlElement | string>;
  readonly line: number;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

export function encodeXmlText(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "");
}

const MAX_DEPTH = 64;

/**
 * Reads a well-formed-enough XML document into a tree. Mismatched end tags
 * close the nearest matching open element, so one damaged record does not
 * lose the rest of the file.
 */
export function parseXml(text: string): XmlElement {
  const root: XmlElement = { name: "#document", attributes: {}, children: [], line: 1 };
  const stack: XmlElement[] = [root];
  let position = 0;
  let line = 1;
  const advanceTo = (next: number) => {
    for (let index = position; index < next; index += 1) if (text[index] === "\n") line += 1;
    position = next;
  };
  while (position < text.length) {
    const open = text.indexOf("<", position);
    const parent = stack.at(-1) ?? root;
    if (open < 0) {
      parent.children.push(decodeXmlEntities(text.slice(position)));
      break;
    }
    if (open > position) parent.children.push(decodeXmlEntities(text.slice(position, open)));
    advanceTo(open);
    if (text.startsWith("<!--", position)) {
      const end = text.indexOf("-->", position + 4);
      advanceTo(end < 0 ? text.length : end + 3);
      continue;
    }
    if (text.startsWith("<![CDATA[", position)) {
      const end = text.indexOf("]]>", position + 9);
      parent.children.push(text.slice(position + 9, end < 0 ? text.length : end));
      advanceTo(end < 0 ? text.length : end + 3);
      continue;
    }
    if (text.startsWith("<?", position)) {
      const end = text.indexOf("?>", position + 2);
      advanceTo(end < 0 ? text.length : end + 2);
      continue;
    }
    if (text.startsWith("<!", position)) {
      const subset = text.indexOf("[", position);
      const close = text.indexOf(">", position);
      const end = subset >= 0 && subset < close ? text.indexOf("]>", subset) + 2 : close + 1;
      advanceTo(end <= 1 ? text.length : end);
      continue;
    }
    const tagEnd = text.indexOf(">", position);
    if (tagEnd < 0) break;
    const tag = text.slice(position + 1, tagEnd);
    const startLine = line;
    advanceTo(tagEnd + 1);
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim().toLowerCase();
      const matching = stack.findLastIndex((element) => element.name === name);
      if (matching > 0) stack.length = matching;
      continue;
    }
    const selfClosing = tag.endsWith("/");
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const nameMatch = body.match(/^\s*([^\s/>]+)/u);
    if (!nameMatch?.[1]) continue;
    const attributes: Record<string, string> = {};
    for (const match of body
      .slice(nameMatch[0].length)
      .matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
      if (match[1])
        attributes[match[1].toLowerCase()] = decodeXmlEntities(match[2] ?? match[3] ?? "");
    }
    const element: XmlElement = {
      name: nameMatch[1].toLowerCase(),
      attributes,
      children: [],
      line: startLine,
    };
    parent.children.push(element);
    if (!selfClosing && stack.length < MAX_DEPTH) stack.push(element);
  }
  return root;
}

export function childElements(element: XmlElement, name?: string): XmlElement[] {
  return element.children.filter(
    (child): child is XmlElement => typeof child !== "string" && (!name || child.name === name),
  );
}

export function findElements(element: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  for (const child of childElements(element)) {
    if (child.name === name) found.push(child);
    else found.push(...findElements(child, name));
  }
  return found;
}

export function textContent(element: XmlElement): string {
  return element.children
    .map((child) => (typeof child === "string" ? child : textContent(child)))
    .join("");
}
