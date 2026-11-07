import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { siteMatchesUrl } from "@t3tools/shared/scientSiteMatch";
import { getDomain } from "tldts";

/** Public list of institutions that sign in to publishers, kept by SeamlessAccess. */
const DIRECTORY = "https://md.seamlessaccess.org/entities/";
const MOST_SHOWN = 10;
/** An entry covering this many domains is a national service, not the user's university. */
const MOST_DOMAINS = 4;

const Entry = Schema.Struct({
  title: Schema.String,
  entityID: Schema.String,
  scope: Schema.optional(Schema.String),
  domain: Schema.optional(Schema.String),
  hidden: Schema.optional(Schema.String),
});
const decodeEntries = Schema.decodeUnknownOption(Schema.Array(Entry));

export interface University {
  readonly name: string;
  readonly entityId: string;
  readonly domain: string;
}

const domainsOf = (entry: typeof Entry.Type) =>
  (entry.scope ?? entry.domain ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);

/** Whether a university's domain is the asked one or holds it, as huji.ac.il holds mail.huji.ac.il. */
const holds = (domain: string, asked: string) => siteMatchesUrl(domain, `https://${asked}`);

export function universitiesFrom(entries: unknown, query: string): ReadonlyArray<University> {
  const decoded = decodeEntries(entries);
  if (Option.isNone(decoded)) return [];
  const asked = query.trim().toLowerCase();
  return decoded.value
    .flatMap((entry) => {
      const domains = domainsOf(entry);
      const domain = domains.find((item) => holds(item, asked)) ?? domains[0];
      return entry.hidden === "true" ||
        domain === undefined ||
        domains.length > MOST_DOMAINS ||
        !URL.canParse(entry.entityID)
        ? []
        : [{ name: entry.title, entityId: entry.entityID, domain }];
    })
    .toSorted(
      (a, b) =>
        Number(holds(b.domain, asked)) - Number(holds(a.domain, asked)) ||
        Number(b.name.toLowerCase().startsWith(asked)) -
          Number(a.name.toLowerCase().startsWith(asked)) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, MOST_SHOWN);
}

/** Universities matching a name or an email domain. Only that text leaves this computer. */
export const searchUniversities = Effect.fn("Papers.searchUniversities")(
  function* (query: string) {
    const http = yield* HttpClient.HttpClient;
    const lookUp = Effect.fn(function* (text: string) {
      const response = yield* http.execute(
        HttpClientRequest.get(`${DIRECTORY}?q=${encodeURIComponent(text)}`, {
          headers: { accept: "application/json" },
        }),
      );
      return response.status === 200 ? universitiesFrom(yield* response.json, query) : [];
    });
    const found = yield* lookUp(query.trim());
    // The directory knows a university by its own domain, not a mail host under it.
    const domain = getDomain(query.trim());
    return found.length > 0 || !domain || domain === query.trim().toLowerCase()
      ? found
      : yield* lookUp(domain);
  },
  Effect.timeoutOption("15 seconds"),
  Effect.map(Option.getOrElse((): ReadonlyArray<University> => [])),
  Effect.orElseSucceed((): ReadonlyArray<University> => []),
);
