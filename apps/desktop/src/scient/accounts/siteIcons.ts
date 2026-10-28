import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

/** A site's whole lookup, page and icons, gives up after this. */
const SITE_TIMEOUT = "8 seconds";
const MAX_PAGE_BYTES = 512_000;
const MAX_ICON_BYTES = 48_000;
const MAX_CANDIDATES = 4;
const MAX_REDIRECTS = 3;
const CONCURRENCY = 4;
const FOUND_FOR_MS = 30 * 24 * 60 * 60_000;
const MISSING_FOR_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 2_000;

const Entry = Schema.Struct({
  icon: Schema.NullOr(Schema.String.check(Schema.isPattern(/^data:image\//))),
  at: Schema.Number,
});
type Entry = typeof Entry.Type;
const CacheFile = Schema.fromJsonString(Schema.Record(Schema.String, Entry));
const decodeCache = Schema.decodeUnknownEffect(CacheFile);
const encodeCache = Schema.encodeEffect(CacheFile);

/**
 * Public host names only: no address, port, single label or local name, so a lookup never reaches
 * the user's own machine or network.
 */
export function iconHost(site: string): string | null {
  const host = site.trim().toLowerCase();
  if (!/^(?=.{1,253}$)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/.test(host)) return null;
  if (/^[\d.]+$/.test(host) || /\.(?:local|localhost|internal|lan|home)$/.test(host)) return null;
  return host;
}

const attribute = (tag: string, name: string) =>
  tag
    .match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))
    ?.slice(1)
    .find((value) => value !== undefined);

/** Icons a page declares, best first: PNG or SVG icons, then any icon, then touch icons. */
export function declaredIcons(html: string, pageUrl: string): ReadonlyArray<string> {
  const icons: Array<{ readonly rank: number; readonly url: string }> = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attribute(tag, "rel")?.toLowerCase() ?? "";
    const href = attribute(tag, "href");
    if (!href || !rel.split(/\s+/).some((token) => token.endsWith("icon"))) continue;
    let url: URL;
    try {
      url = new URL(href.replaceAll("&amp;", "&"), pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "data:") continue;
    const kind = `${attribute(tag, "type") ?? ""} ${url.pathname}`.toLowerCase();
    const rank = rel.includes("apple-touch") ? 2 : /png|svg/.test(kind) ? 0 : 1;
    icons.push({ rank, url: url.href });
  }
  return icons.toSorted((a, b) => a.rank - b.rank).map((icon) => icon.url);
}

/** GET over HTTPS from public hosts only, each redirect included, reading at most `limit` bytes. */
const fetchLimited = Effect.fn("SiteIcons.fetch")(function* (
  http: HttpClient.HttpClient,
  url: string,
  limit: number,
) {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== "https:" || !iconHost(current.hostname)) return Option.none();
    const response = yield* http.execute(HttpClientRequest.get(current.href));
    const location = response.headers["location"];
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    if (response.status < 200 || response.status >= 300) return Option.none();
    const chunks: Uint8Array[] = [];
    let size = 0;
    // Stopping the stream at the limit ends the download.
    yield* response.stream.pipe(
      Stream.takeWhile((chunk) => {
        size += chunk.byteLength;
        if (size <= limit) chunks.push(chunk);
        return size <= limit;
      }),
      Stream.runDrain,
    );
    return Option.some({
      bytes: Buffer.concat(chunks),
      type: response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase(),
      url: current.href,
      complete: size <= limit,
    });
  }
  return Option.none();
});

const iconFrom = (http: HttpClient.HttpClient, url: string) =>
  url.startsWith("data:")
    ? Effect.succeed(url.startsWith("data:image/") && url.length <= MAX_ICON_BYTES * 2 ? url : null)
    : fetchLimited(http, url, MAX_ICON_BYTES).pipe(
        Effect.map((fetched) =>
          Option.isSome(fetched) &&
          fetched.value.complete &&
          fetched.value.type?.startsWith("image/") &&
          fetched.value.bytes.length > 0
            ? `data:${fetched.value.type};base64,${fetched.value.bytes.toString("base64")}`
            : null,
        ),
        Effect.orElseSucceed(() => null),
      );

const lookUp = Effect.fn("SiteIcons.lookUp")(
  function* (http: HttpClient.HttpClient, host: string) {
    const labels = host.split(".");
    // Sign-in hosts such as accounts.example.com often have no page; their domain has the icon.
    for (const candidate of [host, ...(labels.length > 2 ? [labels.slice(1).join(".")] : [])]) {
      const page = yield* fetchLimited(http, `https://${candidate}/`, MAX_PAGE_BYTES).pipe(
        Effect.orElseSucceed(() => Option.none()),
      );
      const pageUrl = Option.isSome(page) ? page.value.url : `https://${candidate}/`;
      const urls = [
        ...(Option.isSome(page) ? declaredIcons(page.value.bytes.toString("utf8"), pageUrl) : []),
        new URL("/favicon.ico", pageUrl).href,
      ].slice(0, MAX_CANDIDATES);
      for (const url of urls) {
        const icon = yield* iconFrom(http, url);
        if (icon) return icon;
      }
    }
    return null;
  },
  Effect.timeoutOption(SITE_TIMEOUT),
  Effect.map((found) => Option.getOrElse(found, () => null)),
);

/**
 * Site icons for Accounts, cached on disk: a found icon for a month, a missing one for a day. A few
 * sites are looked up at a time, without cookies, so a long list never slows the app.
 */
export const makeSiteIcons = Effect.fn("SiteIcons.make")(function* (cacheFile: string) {
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lookups = yield* Semaphore.make(CONCURRENCY);
  let cache: Map<string, Entry> | undefined;
  let saveScheduled = false;

  const load = Effect.suspend(() =>
    cache
      ? Effect.succeed(cache)
      : fs.readFileString(cacheFile).pipe(
          Effect.flatMap(decodeCache),
          Effect.orElseSucceed(() => ({})),
          Effect.map((saved) => {
            cache = new Map(Object.entries(saved));
            return cache;
          }),
        ),
  );
  const write = Effect.suspend(() => {
    saveScheduled = false;
    const temporary = `${cacheFile}.tmp`;
    const entries = [...(cache ?? [])].slice(-MAX_ENTRIES);
    return fs.makeDirectory(path.dirname(cacheFile), { recursive: true }).pipe(
      Effect.andThen(encodeCache(Object.fromEntries(entries))),
      Effect.flatMap((text) => fs.writeFileString(temporary, text)),
      Effect.andThen(fs.rename(temporary, cacheFile)),
      Effect.ignore,
    );
  });
  // Many lookups finish together; one write a couple of seconds later covers them all.
  const scheduleSave = Effect.suspend(() => {
    if (saveScheduled) return Effect.void;
    saveScheduled = true;
    return write.pipe(Effect.delay("2 seconds"), Effect.forkDetach, Effect.asVoid);
  });

  return Effect.fn("SiteIcons.icon")(function* (site: string) {
    const host = iconHost(site);
    if (!host) return null;
    const entries = yield* load;
    const known = entries.get(host);
    if (
      known &&
      (yield* Clock.currentTimeMillis) - known.at < (known.icon ? FOUND_FOR_MS : MISSING_FOR_MS)
    )
      return known.icon;
    const icon = yield* lookups.withPermits(1)(lookUp(http, host));
    entries.delete(host);
    entries.set(host, { icon, at: yield* Clock.currentTimeMillis });
    yield* scheduleSave;
    return icon;
  });
});
