import { isIdentityPage, isLoginPlace } from "@t3tools/shared/scientSignInPage";
import * as Schema from "effect/Schema";

/** What a page shows on the way to a paper. Words are only read here, once a PDF has failed. */
export const PaperPage = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  status: Schema.Number,
  pdf: Schema.Boolean,
  pdfUrl: Schema.NullOr(Schema.String),
  login: Schema.Boolean,
  challenge: Schema.Boolean,
  institutionUrl: Schema.NullOr(Schema.String),
  buy: Schema.Boolean,
});
export type PaperPage = typeof PaperPage.Type;

export const paperPageScript = String.raw`(() => {
  const text = document.body?.innerText ?? "";
  const pdf = document.contentType === "application/pdf";
  const meta = document.querySelector('meta[name="citation_pdf_url"]')?.getAttribute("content");
  const anchors = [...document.querySelectorAll("a[href]")];
  const link = anchors.find((a) =>
    /\.pdf(?:[?#]|$)|\/(?:e?pdf|pdfft|pdfdirect)(?:[/?#]|$)/i.test(a.href) &&
    /pdf/i.test(a.textContent || a.href) &&
    !/suppl|supporting/i.test(a.href + " " + a.textContent),
  )?.href;
  const institution = anchors.find((a) =>
    /access through|institution(?:al)? (?:access|log ?in|sign ?in)|your institution|shibboleth|openathens/i.test(a.textContent ?? "") ||
    /\/user\/institution\/login|ssostart|institutionLogin|\/wayf/i.test(a.href),
  )?.href;
  return {
    url: location.href,
    title: document.title,
    status: performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0,
    pdf,
    pdfUrl: pdf ? location.href : meta ? new URL(meta, location.href).href : (link ?? null),
    login: [...document.querySelectorAll('input[type="password"]')].some((input) => input.getClientRects().length > 0),
    challenge:
      /just a moment|attention required|are you a robot|verify you are human|security check|checking your browser/i.test(document.title) ||
      document.querySelector('#challenge-form, #cf-challenge-running, script[src*="challenges.cloudflare.com"], iframe[src*="challenges.cloudflare.com"]') !== null,
    institutionUrl: institution ?? null,
    buy: /\b(?:buy|purchase|rent) (?:this |the )?(?:article|chapter|access|pdf)|(?:\$|€|£)\s?\d+(?:\.\d\d)?\b/i.test(text),
  };
})()`;

export type PageState =
  | { readonly state: "pdf" }
  | { readonly state: "pdf-link"; readonly url: string }
  | { readonly state: "bot-check" }
  | { readonly state: "sign-in" }
  | { readonly state: "institution"; readonly url: string }
  | { readonly state: "paywall" }
  | { readonly state: "refused" }
  | { readonly state: "unclear" };

const REFUSED = new Set([401, 403, 418, 429]);

/**
 * Why a page has no paper yet. The PDF link comes before the words, because "Purchase access" and
 * a sign-in button sit beside the real PDF for a reader whose university has access. Only a
 * password field or a known sign-in address rule a sign-in, since words vary with the language.
 */
export function pageState(page: PaperPage): PageState {
  if (page.pdf) return { state: "pdf" };
  if (page.challenge) return { state: "bot-check" };
  if (page.login) return { state: "sign-in" };
  if (page.pdfUrl) return { state: "pdf-link", url: page.pdfUrl };
  if (URL.canParse(page.url)) {
    const url = new URL(page.url);
    if (isIdentityPage(url) || isLoginPlace(url)) return { state: "sign-in" };
  }
  if (REFUSED.has(page.status)) return { state: "refused" };
  if (page.institutionUrl) return { state: "institution", url: page.institutionUrl };
  if (page.buy) return { state: "paywall" };
  return { state: "unclear" };
}

/**
 * The PDF's address on publishers whose page doesn't name it to a reader script. The DOI-based
 * ones share a platform; the others follow from the article's own address.
 */
export function pdfAddressFor(pageUrl: string): string | undefined {
  if (!URL.canParse(pageUrl)) return undefined;
  const url = new URL(pageUrl);
  const doiPath = url.pathname.match(
    /^\/doi\/(?:(?:abs|full|pdf|epdf|epub|reader)\/)?(10\.[^?#]+)/u,
  )?.[1];
  if (doiPath)
    return url.hostname.endsWith("wiley.com")
      ? `${url.origin}/doi/pdfdirect/${doiPath}`
      : `${url.origin}/doi/pdf/${doiPath}?download=true`;
  const pii = url.pathname.match(/^\/science\/article\/(?:abs\/)?pii\/([^/?#]+)/u)?.[1];
  if (pii) return `${url.origin}/science/article/pii/${pii}/pdfft?isDTMRedirect=true&download=true`;
  const aps = url.pathname.match(/^\/([a-z]+)\/abstract\/(10\.[^?#]+)/u);
  if (aps && url.hostname === "journals.aps.org") return `${url.origin}/${aps[1]}/pdf/${aps[2]}`;
  const ieee = url.pathname.match(/^\/(?:abstract\/)?document\/(\d+)/u)?.[1];
  if (ieee && url.hostname === "ieeexplore.ieee.org")
    return `${url.origin}/stampPDF/getPDF.jsp?tp=&arnumber=${ieee}`;
  return undefined;
}
