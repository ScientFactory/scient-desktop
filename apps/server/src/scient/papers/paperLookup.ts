import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

const MAX_PDF_BYTES = 200 * 1024 * 1024;
const OPENALEX = "https://api.openalex.org";

/** A DOI anywhere in a link or text: `10.1038/s41586-020-2649-2`, minus trailing punctuation. */
export function doiIn(text: string | undefined): string | undefined {
  const match = text?.match(/\b(10\.\d{4,9}\/[^\s"<>]+)/u)?.[1];
  return match
    ? decodeURIComponent(match)
        .replace(/[).,;\]]+$/u, "")
        .toLowerCase()
    : undefined;
}

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
  primary_location: Schema.optional(Schema.NullOr(Location)),
  locations: Schema.optional(Schema.Array(Location)),
});
const decodeWork = Schema.decodeUnknownOption(Schema.fromJsonString(Work));
export interface Paper {
  readonly doi?: string;
  readonly title?: string;
  readonly year?: number;
  readonly firstAuthor?: string;
  readonly landingUrl: string;
  /** Free legal copies, the published version first. */
  readonly openAccess: ReadonlyArray<{ readonly pdfUrl: string; readonly published: boolean }>;
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
  const copies = (work.locations ?? []).flatMap((location) =>
    location.is_oa && location.pdf_url
      ? [{ pdfUrl: location.pdf_url, published: location.version === "publishedVersion" }]
      : [],
  );
  return {
    ...(resolvedDoi ? { doi: resolvedDoi } : {}),
    ...(work.title ? { title: work.title } : {}),
    ...(work.publication_year ? { year: work.publication_year } : {}),
    ...(work.authorships?.[0] ? { firstAuthor: work.authorships[0].author.display_name } : {}),
    landingUrl:
      url ??
      (resolvedDoi
        ? `https://doi.org/${resolvedDoi}`
        : (work.primary_location?.landing_page_url ?? "")),
    openAccess: copies.toSorted((a, b) => Number(b.published) - Number(a.published)),
  };
}

/** An arXiv id in an abs or pdf link, such as `1706.03762`. */
const arxivIn = (url: string | undefined) =>
  url?.match(/^https:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([\w./-]+?)(?:v\d+)?(?:\.pdf)?$/u)?.[1];

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
      : { doi, landingUrl: input.url ?? `https://doi.org/${doi}`, openAccess: [] };
  }
  const arxiv = arxivIn(input.url);
  if (arxiv)
    return {
      landingUrl: `https://arxiv.org/abs/${arxiv}`,
      openAccess: [{ pdfUrl: `https://arxiv.org/pdf/${arxiv}`, published: false }],
    };
  return input.url ? { landingUrl: input.url, openAccess: [] } : undefined;
});

/** A file's bytes when they are a PDF, read up to the size limit. */
export const downloadPdf = Effect.fn("Papers.downloadPdf")(
  function* (url: string) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(
      HttpClientRequest.get(url, { headers: { accept: "application/pdf,*/*;q=0.5" } }),
    );
    if (response.status !== 200) return undefined;
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
    const bytes = Buffer.concat(chunks);
    return size <= MAX_PDF_BYTES && isPdf(bytes) ? bytes : undefined;
  },
  Effect.timeoutOption("90 seconds"),
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
