import { OfficeCitation } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Office quotes in prompt text: `[Office quote](scient-office-citation://v1/?data=…)`.
 * Kept apart from file and PDF quotes so each kind owns its link format.
 */
export const OFFICE_CITATION_PROTOCOL = "scient-office-citation";
const PREFIX = `${OFFICE_CITATION_PROTOCOL}://v1/`;
const MAX_HREF_LENGTH = 240_000;
// Generated URLs encode parentheses; a raw one ends the scan early.
export const OFFICE_CITATION_LINK =
  /\[Office quote\]\((scient-office-citation:\/\/v1\/[^\s()]{1,240000})\)/g;
const decodeOffice = Schema.decodeUnknownOption(OfficeCitation);

export function formatOfficeCitationHref(citation: OfficeCitation): string {
  return `${PREFIX}?${new URLSearchParams({ data: JSON.stringify(citation) })}`;
}

export function serializeOfficeCitation(citation: OfficeCitation): string {
  return `[Office quote](${formatOfficeCitationHref(citation)})`;
}

export function parseOfficeCitationHref(href: string): OfficeCitation | null {
  if (!href.startsWith(PREFIX) || href.length > MAX_HREF_LENGTH) return null;
  try {
    const url = new URL(href);
    if (
      url.origin !== "null" ||
      url.protocol !== `${OFFICE_CITATION_PROTOCOL}:` ||
      url.hostname !== "v1" ||
      url.pathname !== "/" ||
      url.hash ||
      url.port ||
      url.username ||
      url.password ||
      url.searchParams.size !== 1 ||
      !url.searchParams.has("data")
    )
      return null;
    return Option.getOrNull(decodeOffice(JSON.parse(url.searchParams.get("data")!)));
  } catch {
    return null;
  }
}

/** "report.docx · Page 3" or "talk.pptx · Slide 3". */
export function officeCitationPlaceLabel(citation: OfficeCitation): string {
  const name = citation.path.slice(
    Math.max(citation.path.lastIndexOf("/"), citation.path.lastIndexOf("\\")) + 1,
  );
  return `${name} · ${citation.unit === "slide" ? "Slide" : "Page"} ${citation.page}`;
}

export function officeCitationLabel(citation: OfficeCitation): string {
  const preview = (citation.comment?.trim() || citation.text).replace(/\s+/g, " ").trim();
  const excerpt = preview.length > 64 ? `${preview.slice(0, 64)}…` : preview;
  return `${officeCitationPlaceLabel(citation)} · ${excerpt}`;
}

/** What the agent sees: the file, where in it, and the text. */
export function officeCitationForProvider(citation: OfficeCitation) {
  return {
    kind: "office" as const,
    environmentId: citation.environmentId,
    workspaceRoot: citation.cwd,
    path: citation.path,
    [citation.unit]: citation.page,
    text: citation.text,
    ...(citation.comment === undefined ? {} : { comment: citation.comment }),
  };
}

export const OFFICE_CITATION_PROVIDER_NOTE =
  "Office quotes give text from a Word page or a PowerPoint slide as Scient's reader laid it out; the page number is the reader's, which can differ from Word's. Read the file itself for its full text. The file may have changed since the quote was taken.";
