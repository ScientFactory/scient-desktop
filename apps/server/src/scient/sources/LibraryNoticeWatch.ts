// @effect-diagnostics globalDate:off -- The check's time is kept with the Library as an ISO timestamp.
import {
  readScientLibraryNoticeWatch,
  recordScientLibraryNoticeCheck,
  retractionWatchReader,
  scientLibraryNoticeCoverage,
  scientLibraryWatchedIdentifiers,
} from "@scientfactory/scient-sources/library-notice-watch";
import type { ScientLibraryLocation } from "@scientfactory/scient-sources/library-root";

import { METADATA_USER_AGENT } from "./metadataHttp.ts";

/** Crossref's public copy of the Retraction Watch database, replaced each working day. */
const RETRACTION_WATCH_FILE =
  "https://gitlab.com/crossref/retraction-watch-data/-/raw/main/retraction_watch.csv";
const CHECK_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
/** The file is about 70 MB; a slow line still gets it, a stalled one is given up. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

type Fetch = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal },
) => Promise<Response>;

/**
 * The weekly check for notices on papers the Library already holds. One request for a public
 * file, matched here, so no service learns which works the Library has. Anything short of the
 * whole file throws: nothing is written, and the next pass tries again.
 */
export async function runLibraryNoticeWatch(input: {
  readonly library: ScientLibraryLocation;
  readonly fetch?: Fetch;
  readonly now?: () => Date;
  /** The server stopping: the download is given up. */
  readonly signal?: AbortSignal;
}): Promise<"not-due" | "nothing-to-check" | "unchanged" | "checked"> {
  const now = (input.now ?? (() => new Date()))();
  const last = await readScientLibraryNoticeWatch(input.library);
  if (last && now.getTime() - Date.parse(last.checkedAt) < CHECK_EVERY_MS) return "not-due";
  const wanted = await scientLibraryWatchedIdentifiers(input.library);
  if (wanted.size === 0) return "nothing-to-check";
  // "Unchanged" covers only the papers the last whole read matched; any other asks for the file.
  const etag = last?.covered === scientLibraryNoticeCoverage(wanted) ? last.etag : undefined;

  const response = await (input.fetch ?? fetch)(RETRACTION_WATCH_FILE, {
    headers: {
      "User-Agent": METADATA_USER_AGENT,
      ...(etag ? { "If-None-Match": etag } : {}),
    },
    signal: AbortSignal.any([
      AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      ...(input.signal ? [input.signal] : []),
    ]),
  });
  const checkedAt = now.toISOString();
  if (response.status === 304 && etag) {
    await recordScientLibraryNoticeCheck({
      library: input.library,
      found: null,
      etag: null,
      checkedAt,
    });
    return "unchanged";
  }
  if (response.status !== 200 || !response.body) {
    throw new Error(`The Retraction Watch file answered ${response.status}.`);
  }
  const reader = retractionWatchReader(wanted);
  const decoder = new TextDecoder();
  for await (const chunk of response.body) reader.push(decoder.decode(chunk, { stream: true }));
  reader.push(decoder.decode());
  await recordScientLibraryNoticeCheck({
    library: input.library,
    found: reader.end(),
    etag: response.headers.get("etag"),
    checkedAt,
  });
  return "checked";
}
