import { ComputeCitation } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Compute quotes in prompt text: `[Compute quote](scient-compute-citation://v1/?data=…)`.
 * Kept apart from file and PDF quotes so each kind owns its link format.
 */
export const COMPUTE_CITATION_PROTOCOL = "scient-compute-citation";
const PREFIX = `${COMPUTE_CITATION_PROTOCOL}://v1/`;
const MAX_HREF_LENGTH = 240_000;
// Generated URLs encode parentheses; a raw one ends the scan early.
export const COMPUTE_CITATION_LINK =
  /\[Compute quote\]\((scient-compute-citation:\/\/v1\/[^\s()]{1,240000})\)/g;
const decodeCompute = Schema.decodeUnknownOption(ComputeCitation);

export function formatComputeCitationHref(citation: ComputeCitation): string {
  return `${PREFIX}?${new URLSearchParams({ data: JSON.stringify(citation) })}`;
}

export function serializeComputeCitation(citation: ComputeCitation): string {
  return `[Compute quote](${formatComputeCitationHref(citation)})`;
}

export function parseComputeCitationHref(href: string): ComputeCitation | null {
  if (!href.startsWith(PREFIX) || href.length > MAX_HREF_LENGTH) return null;
  try {
    const url = new URL(href);
    if (
      url.origin !== "null" ||
      url.protocol !== `${COMPUTE_CITATION_PROTOCOL}:` ||
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
    return Option.getOrNull(decodeCompute(JSON.parse(url.searchParams.get("data")!)));
  } catch {
    return null;
  }
}

function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** "Console", "fit.py", or "analysis.ipynb · Cell 3". */
export function computeCitationPlaceLabel(citation: ComputeCitation): string {
  const { place } = citation;
  if (place._tag === "cell") return `${fileName(place.path)} · Cell ${place.number}`;
  return place.path === null ? "Console" : fileName(place.path);
}

export function computeCitationLabel(citation: ComputeCitation): string {
  const preview = (citation.comment?.trim() || citation.text).replace(/\s+/g, " ").trim();
  const excerpt = preview.length > 64 ? `${preview.slice(0, 64)}…` : preview;
  return `${computeCitationPlaceLabel(citation)} · ${excerpt}`;
}

/**
 * What the agent sees: the text, the ids its tools take to read the rest, and the workspace they
 * belong to, which may no longer be the conversation's.
 */
export function computeCitationForProvider(citation: ComputeCitation) {
  const { place } = citation;
  return {
    kind: "compute" as const,
    environmentId: citation.environmentId,
    workspaceRoot: citation.cwd,
    place:
      place._tag === "cell"
        ? { type: "cell" as const, path: place.path, cell: place.cellId, number: place.number }
        : place._tag === "file-run"
          ? { type: "file-run" as const, path: place.path, run: place.runId }
          : {
              type: "run" as const,
              session: place.sessionId,
              run: place.executionId,
              ...(place.path === null ? {} : { path: place.path }),
            },
    text: citation.text,
    ...(citation.comment === undefined ? {} : { comment: citation.comment }),
  };
}

export const COMPUTE_CITATION_PROVIDER_NOTE =
  "Compute quotes give text from a run or a notebook cell, or the code of the run or cell asked about. Read a run in full, with its errors and figures, with scient_compute_output (session, run), or a file-run with scient_compute_run_file (path, run). Read a cell with its output with scient_notebook_read (path, cells). Those tools read the current workspace, so a quote from another workspaceRoot may not be readable there, and the same path there may be a different notebook. A notebook may have changed since the quote was taken.";
