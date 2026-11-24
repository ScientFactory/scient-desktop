import { createContext } from "react";

export const LatexResultFileDigests = createContext<Readonly<Record<string, string>> | null>(null);

/** The asset grant still names the same file. The digest selects its browser cache entry. */
export function latexPlacedImageUrl(url: string, sha256: string | undefined): string {
  if (sha256 === undefined) return url;
  const versioned = new URL(url);
  versioned.searchParams.set("result", sha256);
  return versioned.href;
}
