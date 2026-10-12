import type { JSONContent } from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";

const nodes = new WeakMap<DocumentNode, JSONContent>();
const serialized = new WeakMap<DocumentNode, string>();

function documentEnvelope(doc: DocumentNode): JSONContent {
  const json: JSONContent = { type: doc.type.name };
  if (Object.keys(doc.attrs).length) json.attrs = doc.attrs;
  if (doc.marks.length) json.marks = doc.marks.map((mark) => mark.toJSON());
  return json;
}

/** ProseMirror nodes are immutable; unchanged blocks retain their wire identity. */
export function visualDocumentJson(doc: DocumentNode): JSONContent {
  const content: JSONContent[] = [];
  doc.forEach((node) => {
    let json = nodes.get(node);
    if (!json) {
      json = node.toJSON() as JSONContent;
      nodes.set(node, json);
    }
    content.push(json);
  });
  const json = documentEnvelope(doc);
  if (content.length) json.content = content;
  return json;
}

function authoredAttributes(this: JSONContent, key: string, value: unknown): unknown {
  if (
    key !== "attrs" ||
    typeof this.type !== "string" ||
    !value ||
    typeof value !== "object" ||
    !("sourceId" in value || "sourceMeta" in value)
  )
    return value;
  const attrs = { ...(value as Record<string, unknown>) };
  const metadata = attrs.sourceMeta;
  delete attrs.sourceId;
  delete attrs.sourceMeta;
  // A split item may still belong to its original item. This offset groups
  // intent only; recovery verifies surviving semantics before binding ranges.
  if (
    this.type === "listItem" &&
    metadata &&
    typeof metadata === "object" &&
    "from" in metadata &&
    typeof metadata.from === "number"
  )
    attrs.sourceMeta = { from: metadata.from };
  return attrs;
}

/** Reuse authored block encodings in the existing recovery JSON envelope. */
export function serializedVisualDocument(doc: DocumentNode): string {
  const content: string[] = [];
  doc.forEach((node) => {
    let json = serialized.get(node);
    if (json === undefined) {
      json = JSON.stringify(node.toJSON(), authoredAttributes);
      serialized.set(node, json);
    }
    content.push(json);
  });
  const envelope = JSON.stringify(documentEnvelope(doc), authoredAttributes);
  return content.length ? `${envelope.slice(0, -1)},"content":[${content.join(",")}]}` : envelope;
}
