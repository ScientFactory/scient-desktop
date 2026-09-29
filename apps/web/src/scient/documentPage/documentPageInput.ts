import {
  SCIENT_DOCUMENT_CAPTURE_INPUT_FILE,
  SCIENT_DOCUMENT_PAGE_INPUT_PARAMETER,
  ScientDocumentPageInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeInput = Schema.decodeUnknownSync(ScientDocumentPageInput);

export class DocumentPageInputError extends Error {
  constructor(
    readonly code: "input-unavailable" | "input-invalid",
    message: string,
  ) {
    super(message);
    this.name = "DocumentPageInputError";
  }
}

/** Reads the signed capture URL from the page fragment; only an absolute http(s) input is accepted. */
export function readDocumentPageInputUrl(hash: string): URL {
  const raw = new URLSearchParams(hash.replace(/^#/u, "")).get(
    SCIENT_DOCUMENT_PAGE_INPUT_PARAMETER,
  );
  let url: URL | null = null;
  try {
    url = raw ? new URL(raw) : null;
  } catch {
    url = null;
  }
  if (
    url === null ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.pathname.endsWith(`/${SCIENT_DOCUMENT_CAPTURE_INPUT_FILE}`)
  ) {
    throw new DocumentPageInputError("input-unavailable", "The document page has no valid input.");
  }
  return url;
}

export async function loadDocumentPageInput(
  inputUrl: URL,
  fetchInput: typeof fetch = fetch,
): Promise<ScientDocumentPageInput> {
  let response: Response;
  try {
    response = await fetchInput(inputUrl, { credentials: "omit", cache: "no-store" });
  } catch {
    throw new DocumentPageInputError(
      "input-unavailable",
      "The document page could not load the captured document.",
    );
  }
  if (!response.ok) {
    throw new DocumentPageInputError(
      "input-unavailable",
      `The captured document is unavailable (HTTP ${response.status}).`,
    );
  }
  try {
    return decodeInput(await response.json());
  } catch {
    throw new DocumentPageInputError(
      "input-invalid",
      "The captured document is not a valid Scient document page input.",
    );
  }
}
