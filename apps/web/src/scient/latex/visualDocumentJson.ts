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

/** Reuse unchanged block encodings without changing the durable recovery format. */
export function serializedVisualDocument(doc: DocumentNode): string {
  const content: string[] = [];
  doc.forEach((node) => {
    let json = serialized.get(node);
    if (json === undefined) {
      json = JSON.stringify(node.toJSON());
      serialized.set(node, json);
    }
    content.push(json);
  });
  const envelope = JSON.stringify(documentEnvelope(doc));
  return content.length ? `${envelope.slice(0, -1)},"content":[${content.join(",")}]}` : envelope;
}
