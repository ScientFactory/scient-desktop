import { type AccountSummary, keyServesUse, type LibraryKeyUse } from "@t3tools/contracts";

import { anySiteMatches } from "./scientSiteMatch.ts";

/** Where each Library lookup sends its key, matched against an Accounts row's sites. */
export const LIBRARY_KEY_URLS = {
  zotero: "https://api.zotero.org/",
  openAlex: "https://api.openalex.org/",
  semanticScholar: "https://api.semanticscholar.org/",
  ncbi: "https://eutils.ncbi.nlm.nih.gov/",
  googleBooks: "https://www.googleapis.com/books/",
  unpaywallEmail: "https://api.unpaywall.org/",
} as const satisfies Record<LibraryKeyUse, string>;

const isZoteroSite = (site: string) => {
  const host = site.replace(/^https:\/\//u, "").replace(/[:/].*$/u, "");
  return host === "zotero.org" || host.endsWith(".zotero.org");
};

/** Whether a saved key can serve this Library lookup; Zotero also by its ZOTERO_API_KEY variable. */
export function libraryKeyFits(use: LibraryKeyUse, account: AccountSummary): boolean {
  const { details } = account;
  if (
    details.kind !== "api-key" ||
    account.secrets.token === undefined ||
    !keyServesUse(account, { kind: "library", id: use })
  )
    return false;
  return use === "zotero"
    ? details.sites.some(isZoteroSite) || details.envName === "ZOTERO_API_KEY"
    : anySiteMatches(details.sites, LIBRARY_KEY_URLS[use]);
}
