import type { ScientSourceRecord } from "@scientfactory/scient-sources";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";

type Reference = Pick<
  ScientSourceRecord,
  "title" | "creators" | "issuedYear" | "identifiers" | "url"
>;

function sourceUrl(record: Reference): string | null {
  const doi = record.identifiers
    .find((item) => item.scheme.toLowerCase() === "doi")
    ?.value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "")
    .replace(/^doi:\s*/iu, "")
    .trim();
  if (doi && /^10\.\d{4,9}\/\S+$/iu.test(doi))
    return "https://doi.org/" + doi.split("/").map(encodeURIComponent).join("/");
  try {
    const url = new URL(record.url ?? "");
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function html(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

/** Short reading attribution, not a manuscript citation or a replacement for CSL. */
export function sourceExcerptCopy(
  record: Reference,
  pages: ReadonlyArray<{ page: number; quote: string }>,
) {
  const authors = record.creators
    .filter((creator) => ["author", "bookauthor"].includes(creator.creatorType))
    .map(
      (creator) =>
        creator.literalName?.trim() || creator.familyName?.trim() || creator.givenName?.trim(),
    )
    .filter(Boolean);
  const author = authors.length > 2 ? authors[0] + " et al." : authors.join(" & ");
  const title = record.title?.trim() || "Untitled source";
  const label = [author, title + (record.issuedYear ? ` (${record.issuedYear})` : "")]
    .filter(Boolean)
    .join(" · ");
  const url = sourceUrl(record);
  const location =
    "PDF " + (pages.length === 1 ? "page " : "pages ") + pages.map((page) => page.page).join(", ");
  const quote = pages.map((page) => page.quote).join("\n\n");
  const escapedLabel = label.replace(/[\\[\]`*_<>]/gu, "\\$&");
  const markdown =
    quote
      .split("\n")
      .map((line) => "> " + line)
      .join("\n") +
    "\n\n" +
    (url ? `[${escapedLabel}](<${url}>)` : escapedLabel) +
    " · " +
    location;
  return {
    markdown,
    html: `<blockquote>${html(quote).replaceAll("\n", "<br>")}</blockquote><p>${url ? `<a href="${html(url)}">${html(label)}</a>` : html(label)} · ${location}</p>`,
  };
}

export async function copySourceExcerpt(payload: ReturnType<typeof sourceExcerptCopy>) {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([payload.markdown], { type: "text/plain" }),
          "text/html": new Blob([payload.html], { type: "text/html" }),
        }),
      ]);
      return;
    } catch {
      // Plain-text Markdown retains the destination URL when rich copy is unavailable.
    }
  }
  await writeTextToClipboard(payload.markdown, "cited excerpt");
}
