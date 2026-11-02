import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

const MAX_PDF_BYTES = 200 * 1024 * 1024;
const OPENALEX = "https://api.openalex.org";

const decodeDoi = (doi: string) => {
  try {
    return decodeURIComponent(doi);
  } catch {
    return doi;
  }
};

/** A DOI anywhere in a link or text: `10.1038/s41586-020-2649-2`, minus trailing punctuation. */
export function doiIn(text: string | undefined): string | undefined {
  const match = text?.match(/\b(10\.\d{4,9}\/[^\s"<>]+)/u)?.[1];
  if (!match) return undefined;
  const clean = match.replace(/[).,;\]]+$/u, "").toLowerCase();
  return URL.canParse(`https://doi.org/${clean}`) ? decodeDoi(clean) : undefined;
}

const Biblio = Schema.Struct({
  first_page: Schema.optional(Schema.NullOr(Schema.String)),
  last_page: Schema.optional(Schema.NullOr(Schema.String)),
});
const Location = Schema.Struct({
  is_oa: Schema.optional(Schema.NullOr(Schema.Boolean)),
  pdf_url: Schema.optional(Schema.NullOr(Schema.String)),
  landing_page_url: Schema.optional(Schema.NullOr(Schema.String)),
  version: Schema.optional(Schema.NullOr(Schema.String)),
});
const Work = Schema.Struct({
  doi: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  publication_year: Schema.optional(Schema.NullOr(Schema.Number)),
  authorships: Schema.optional(
    Schema.Array(Schema.Struct({ author: Schema.Struct({ display_name: Schema.String }) })),
  ),
  biblio: Schema.optional(Schema.NullOr(Biblio)),
  primary_location: Schema.optional(Schema.NullOr(Location)),
  locations: Schema.optional(Schema.Array(Location)),
});
const decodeWork = Schema.decodeUnknownOption(Schema.fromJsonString(Work));
const Handle = Schema.Struct({
  values: Schema.Array(Schema.Struct({ data: Schema.Struct({ value: Schema.Unknown }) })),
});
const decodeHandle = Schema.decodeUnknownOption(Schema.fromJsonString(Handle));
export interface Paper {
  readonly doi?: string;
  readonly title?: string;
  readonly year?: number;
  readonly firstAuthor?: string;
  readonly landingUrl: string;
  /** The article at its publisher, once known: a DOI link can't carry a university's sign-in. */
  readonly articleUrl?: string;
  /** Its length in print, which tells a preview from the paper. */
  readonly pages?: number;
  /** Free legal copies, the published version first. */
  readonly openAccess: ReadonlyArray<{
    readonly pdfUrl?: string;
    /** No direct PDF address is known; the article page names it. */
    readonly pageUrl?: string;
    readonly published: boolean;
  }>;
}

const getText = (http: HttpClient.HttpClient, url: string) =>
  http.execute(HttpClientRequest.get(url, { headers: { accept: "application/json" } })).pipe(
    Effect.flatMap((response) =>
      response.status === 200 ? Effect.asSome(response.text) : Effect.succeedNone,
    ),
    Effect.timeoutOption("15 seconds"),
    Effect.map((text) => Option.getOrUndefined(Option.flatten(text))),
    Effect.orElseSucceed(() => undefined),
  );

function paperFrom(
  work: typeof Work.Type,
  doi: string | undefined,
  url: string | undefined,
): Paper {
  const resolvedDoi = doiIn(work.doi ?? undefined) ?? doi;
  const copies = (work.locations ?? []).flatMap((location): Paper["openAccess"] => {
    const published = location.version === "publishedVersion";
    if (!location.is_oa) return [];
    if (location.pdf_url) return [{ pdfUrl: location.pdf_url, published }];
    return location.landing_page_url ? [{ pageUrl: location.landing_page_url, published }] : [];
  });
  const first = Number(work.biblio?.first_page);
  const last = Number(work.biblio?.last_page);
  const pages = last >= first && first > 0 ? last - first + 1 : undefined;
  return {
    ...(resolvedDoi ? { doi: resolvedDoi } : {}),
    ...(pages ? { pages } : {}),
    ...(work.title ? { title: work.title } : {}),
    ...(work.publication_year ? { year: work.publication_year } : {}),
    ...(work.authorships?.[0] ? { firstAuthor: work.authorships[0].author.display_name } : {}),
    landingUrl:
      url ??
      (resolvedDoi
        ? `https://doi.org/${resolvedDoi}`
        : (work.primary_location?.landing_page_url ?? "")),
    openAccess: copies.toSorted(
      (a, b) =>
        Number(b.published) - Number(a.published) || Number("pdfUrl" in b) - Number("pdfUrl" in a),
    ),
  };
}

/** An arXiv id in an abs or pdf link, such as `1706.03762`. */
const arxivIn = (url: string | undefined) =>
  url?.match(/^https:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([\w./-]+?)(?:v\d+)?(?:\.pdf)?$/u)?.[1];

/** Where a DOI points. Elsevier's address needs its article page, not its redirector. */
export const articleAddress = Effect.fn("Papers.articleAddress")(function* (doi: string) {
  const http = yield* HttpClient.HttpClient;
  const text = yield* getText(http, `https://doi.org/api/handles/${encodeURI(doi)}?type=URL`);
  const handle = text === undefined ? Option.none() : decodeHandle(text);
  const url = Option.isSome(handle) ? handle.value.values[0]?.data.value : undefined;
  if (typeof url !== "string" || !URL.canParse(url)) return undefined;
  const pii = url.match(/^https?:\/\/linkinghub\.elsevier\.com\/retrieve\/pii\/([^/?#]+)/u)?.[1];
  return pii ? `https://www.sciencedirect.com/science/article/pii/${pii}` : url;
});

/** What OpenAlex knows about the paper a DOI or link names. */
export const lookUpPaper = Effect.fn("Papers.lookUp")(function* (input: {
  readonly doi?: string | undefined;
  readonly url?: string | undefined;
}) {
  const http = yield* HttpClient.HttpClient;
  const doi = doiIn(input.doi) ?? doiIn(input.url);
  if (doi) {
    const text = yield* getText(http, `${OPENALEX}/works/doi:${encodeURI(doi)}`);
    const work = text === undefined ? Option.none() : decodeWork(text);
    return Option.isSome(work)
      ? paperFrom(work.value, doi, input.url)
      : {
          doi,
          landingUrl: input.url ?? `https://doi.org/${doi}`,
          openAccess: [{ pageUrl: input.url ?? `https://doi.org/${doi}`, published: true }],
        };
  }
  const arxiv = arxivIn(input.url);
  if (arxiv)
    return {
      landingUrl: `https://arxiv.org/abs/${arxiv}`,
      openAccess: [{ pdfUrl: `https://arxiv.org/pdf/${arxiv}`, published: false }],
    };
  return input.url
    ? { landingUrl: input.url, openAccess: [{ pageUrl: input.url, published: true }] }
    : undefined;
});

/** A response's bytes up to the size limit, or nothing when it is larger. */
const readBody = Effect.fn("Papers.readBody")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  yield* response.stream.pipe(
    Stream.takeWhile((chunk) => {
      size += chunk.byteLength;
      if (size <= MAX_PDF_BYTES) chunks.push(chunk);
      return size <= MAX_PDF_BYTES;
    }),
    Stream.runDrain,
  );
  return size <= MAX_PDF_BYTES ? Buffer.concat(chunks) : undefined;
});

/** A file's bytes when they are a PDF, read up to the size limit. */
const downloadPdf = Effect.fn("Papers.downloadPdf")(
  function* (url: string) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(
      HttpClientRequest.get(url, { headers: { accept: "application/pdf,*/*;q=0.5" } }),
    );
    if (response.status !== 200) return undefined;
    const bytes = yield* readBody(response);
    return bytes && isPdf(bytes) ? bytes : undefined;
  },
  Effect.timeoutOption("90 seconds"),
  Effect.map(Option.getOrUndefined),
  Effect.orElseSucceed(() => undefined),
);

const META_PDF =
  /<meta[^>]*name=["']citation_pdf_url["'][^>]*content=["']([^"']+)["'][^>]*>|<meta[^>]*content=["']([^"']+)["'][^>]*name=["']citation_pdf_url["'][^>]*>/iu;

/** The PDF address an article page declares for scholarly indexers. */
export function citationPdfUrl(html: string, pageUrl: string) {
  const match = META_PDF.exec(html);
  const found = (match?.[1] ?? match?.[2])?.replaceAll("&amp;", "&");
  if (!found || !URL.canParse(found, pageUrl)) return undefined;
  const url = new URL(found, pageUrl);
  return url.protocol === "https:" ? url.href : undefined;
}

/** A free copy's PDF, by its direct address, its link or through its article page. */
export const openAccessPdf = Effect.fn("Papers.openAccessPdf")(
  function* (copy: Paper["openAccess"][number]) {
    if (copy.pdfUrl) return yield* downloadPdf(copy.pdfUrl);
    if (!copy.pageUrl) return undefined;
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(
      HttpClientRequest.get(copy.pageUrl, {
        headers: { accept: "text/html,application/pdf;q=0.9" },
      }),
    );
    if (response.status !== 200) return undefined;
    const body = yield* readBody(response);
    if (!body) return undefined;
    // A link can be the PDF itself.
    if (isPdf(body)) return body;
    const pdfUrl = citationPdfUrl(body.toString("utf8"), response.url);
    return pdfUrl ? yield* downloadPdf(pdfUrl) : undefined;
  },
  Effect.timeoutOption("120 seconds"),
  Effect.map(Option.getOrUndefined),
  Effect.orElseSucceed(() => undefined),
);

export const isPdf = (bytes: Uint8Array) =>
  bytes.byteLength > 4 && Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";

/** `papers/Harris-2020-Array-programming-with-NumPy.pdf`, from what is known. */
export function paperFileName(paper: Paper) {
  const words = (value: string | undefined, max: number) =>
    (value ?? "")
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, max)
      .join("-");
  const name = [
    words(paper.firstAuthor?.split(/\s+/u).at(-1), 1),
    paper.year?.toString(),
    words(paper.title, 6),
  ]
    .filter(Boolean)
    .join("-");
  return `${(name || paper.doi?.replace(/[^\w.-]+/gu, "_") || "paper").slice(0, 120)}.pdf`;
}
