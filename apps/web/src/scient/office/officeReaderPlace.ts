import type { OfficeFile } from "./officeQuote";

/** Where a reader was in an Office file, so opening the file again returns there. */
export interface OfficeReaderPlace {
  /** The page or slide at the top of the view, from 0. */
  readonly page: number;
  /** The point on that page at the top of the view, in the page's own units. */
  readonly y: number;
  readonly zoom: number | "fit" | undefined;
}

// Kept for this window's session, like the PDF reader's; the oldest place goes past the limit.
const LIMIT = 100;
const places = new Map<string, OfficeReaderPlace>();

export const officeReaderPlaceKey = (file: OfficeFile) =>
  JSON.stringify([file.citeThread.environmentId, file.cwd, file.path]);

export const officeReaderPlace = (key: string) => places.get(key);

export function rememberOfficeReaderPlace(key: string, place: OfficeReaderPlace) {
  places.delete(key);
  places.set(key, place);
  if (places.size > LIMIT) places.delete(places.keys().next().value!);
}
