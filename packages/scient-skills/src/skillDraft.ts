import { Document, parseDocument } from "yaml";

import { parseSkillDocument } from "./skillDocument.ts";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** A skill name made from any text: lowercase words joined by hyphens, at most 64 characters. */
export function skillNameFrom(text: string): string | undefined {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/\.(md|markdown|txt|skill|zip)$/u, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/u, "");
  return slug.length > 0 ? slug : undefined;
}

export type SkillDraft =
  | {
      readonly status: "ready";
      readonly name: string;
      readonly description: string;
      /** SKILL.md as it will be saved, with any mechanical fix applied. */
      readonly contents: string;
      /** Fixes Scient made, in plain words. */
      readonly notes: ReadonlyArray<string>;
    }
  | {
      readonly status: "needs-agent";
      /** What is missing, in plain words; an agent can finish it. */
      readonly reason: string;
      readonly name?: string;
    };

/**
 * Whether a skill document can be saved as is, after the fixes Scient can make on its own (a
 * missing or mismatched name), or needs an agent to finish it (no header, no description, no
 * instructions). `fallbackName` is the folder or file name it came from.
 */
export function prepareSkillDocument(document: string, fallbackName: string): SkillDraft {
  // A byte-order mark from some editors would hide the header.
  const contents = document.replace(/^\uFEFF/u, "");
  const fallback = skillNameFrom(fallbackName);
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return {
      status: "needs-agent",
      reason: "It has no skill header with a name and a description.",
      ...(fallback ? { name: fallback } : {}),
    };
  }
  let header: Document;
  try {
    header = parseDocument(match[1] ?? "");
  } catch {
    return { status: "needs-agent", reason: "Its header could not be read." };
  }
  const record: unknown = header.errors.length > 0 ? undefined : header.toJS();
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return { status: "needs-agent", reason: "Its header could not be read." };
  }
  const fields = record as Record<string, unknown>;
  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  const given = typeof fields.name === "string" ? fields.name.trim() : "";
  const name =
    (SKILL_NAME_PATTERN.test(given) && given.length <= 64 ? given : undefined) ??
    skillNameFrom(given) ??
    fallback;
  if (description.length === 0) {
    return {
      status: "needs-agent",
      reason: "It has no description, which agents use to decide when to use it.",
      ...(name ? { name } : {}),
    };
  }
  if (contents.slice(match[0].length).trim().length === 0) {
    return {
      status: "needs-agent",
      reason: "It has a header but no instructions.",
      ...(name ? { name } : {}),
    };
  }
  if (!name) return { status: "needs-agent", reason: "It has no usable name." };
  const notes: string[] = [];
  let fixed = contents;
  if (name !== given) {
    header.set("name", name);
    fixed = `---\n${header.toString()}---\n${contents.slice(match[0].length)}`;
    notes.push(
      given ? `Renamed to “${name}” to fit skill names.` : `Named “${name}” after its file.`,
    );
  }
  try {
    const parsed = parseSkillDocument(fixed, name);
    return {
      status: "ready",
      name,
      description: parsed.metadata.description,
      contents: fixed,
      notes,
    };
  } catch (error) {
    return {
      status: "needs-agent",
      reason: error instanceof Error ? error.message : "It is not a valid skill yet.",
      name,
    };
  }
}
