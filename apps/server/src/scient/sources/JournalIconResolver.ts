// @effect-diagnostics nodeBuiltinImport:off -- Journal icons are fetched and cached by the host.
// @effect-diagnostics globalDate:off -- Cache freshness uses persisted wall-clock resolution times.
// @effect-diagnostics globalTimers:off -- This Promise-based HTTPS boundary aborts native requests at its deadline.
import * as NodeCrypto from "node:crypto";
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";
import * as NodeTimersPromises from "node:timers/promises";

import {
  normalizePersistentIdentifier,
  type ScientSourceRecord,
} from "@scientfactory/scient-sources";
import { journalIconIdentity } from "@t3tools/shared/scientJournalIdentity";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { getDomain } from "tldts";

import { withRegistryContact } from "./metadataHttp.ts";
import { createSerialRequestLane } from "./NcbiRequestLane.ts";
import { rasterizeJournalSvg, validateJournalRaster } from "./JournalIconImage.ts";
import {
  publisherArtworkCandidates,
  publisherControlsWebsite,
  venueArtworkCandidates,
} from "./JournalPublisherArtwork.ts";

const ICON_REQUEST_TIMEOUT_MS = 2_000;
const ICON_DISCOVERY_TIMEOUT_MS = 6_000;
const MAX_ICON_BYTES = 128 * 1024;
const MAX_ICON_DOCUMENT_BYTES = 512 * 1024;
const MAX_CROSSREF_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const MAX_DECLARED_ICON_ATTEMPTS = 3;
const ICON_DISCOVERY_VERSION = 7;
const SUCCESS_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const FAILURE_TTL_MS = 60_000;
const MAX_FAILURE_TTL_MS = 6 * 60 * 60 * 1_000;
const MAX_SOURCE_FAILURES = 64;
const USER_AGENT =
  "Scient/0.0 (https://github.com/ScientFactory/scient-desktop; journal icon resolution)";

// Registries have independent rate limits; one slow service must not occupy another's lane.
const registryLanes = new Map(
  ["api.crossref.org", "api.datacite.org", "api.openalex.org"].map((host) => [
    host,
    createSerialRequestLane({ minimumStartIntervalMs: 200 }),
  ]),
);

const blockedAddresses = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2002::", 16],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

const intermediaryHosts = [
  "crossref.org",
  "doi.org",
  "ebi.ac.uk",
  "europepmc.org",
  "ncbi.nlm.nih.gov",
  "zotero.org",
  "adsabs.harvard.edu",
  "semanticscholar.org",
  "researchgate.net",
  "openalex.org",
  "scholar.google.com",
  "core.ac.uk",
] as const;

type IconFormat = {
  readonly extension: "gif" | "ico" | "jpg" | "png" | "webp";
  readonly mediaType:
    | "image/gif"
    | "image/jpeg"
    | "image/png"
    | "image/vnd.microsoft.icon"
    | "image/webp";
};

type DownloadedIcon = IconFormat & {
  readonly bytes: Uint8Array;
  readonly sourceUrl?: string;
  readonly artworkTitle?: string;
};

type CacheMetadata = IconFormat & {
  readonly discoveryVersion: number;
  readonly resolvedAt: string;
  readonly sourceHost: string;
  readonly sourceUrl?: string;
  readonly artworkTitle?: string;
};

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

type DeclaredIconCandidate = {
  readonly declaredSize: number;
  readonly url: URL;
  readonly touchIcon: boolean;
  readonly branding: boolean;
};

export interface JournalIconMaterial {
  readonly absolutePath: string;
  readonly cacheRoot: string;
  readonly journalTitle: string;
}

type HopResponse = {
  readonly status: number;
  readonly location: string | null;
  readonly body: Buffer;
  /** The body stopped at maxBytes; the rest was not read. */
  readonly truncated?: boolean;
};

/** One HTTPS exchange that never follows redirects; the default pins a verified public address. */
export type PublicHttpsHop = (input: {
  readonly url: URL;
  readonly accept: string;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}) => Promise<HopResponse>;

export interface JournalIconResolverOptions {
  readonly now?: () => Date;
  readonly resolveLandingUrl?: (record: ScientSourceRecord) => Promise<URL | null>;
  readonly downloadIcon?: (landingUrl: URL) => Promise<DownloadedIcon | null>;
  readonly httpsHop?: PublicHttpsHop;
}

const activeResolutions = new Map<
  string,
  {
    readonly requestKey: string;
    readonly promise: Promise<JournalIconMaterial | null>;
  }
>();

function isIntermediaryHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  return intermediaryHosts.some((host) => normalized === host || normalized.endsWith(`.${host}`));
}

function parseEligiblePublicUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" && (!url.port || url.port === "80")) {
      url.port = "";
      url.protocol = "https:";
    }
    if (url.protocol !== "https:" || (url.port && url.port !== "443")) return null;
    if (url.username || url.password || isIntermediaryHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function sourceDoi(record: ScientSourceRecord): string | null {
  const doi = record.identifiers.find(
    (identifier) => identifier.scheme.trim().toLowerCase() === "doi",
  );
  if (!doi) return null;
  const normalized = normalizePersistentIdentifier("doi", doi.value);
  return normalized.startsWith("doi:") ? normalized.slice(4) : null;
}

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function crossrefLandingUrl(value: unknown): URL | null {
  const message = object(object(value)?.message);
  const primary = object(object(message?.resource)?.primary);
  return (
    parseEligiblePublicUrl(typeof primary?.URL === "string" ? primary.URL : null) ??
    parseEligiblePublicUrl(typeof message?.URL === "string" ? message.URL : null)
  );
}

function conferenceHomepage(record: ScientSourceRecord): URL | null {
  const title = record.containerTitle?.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
  // An arXiv DOI identifies a version, not the proceedings venue stored on the source.
  if (
    title &&
    /^(?:(?:advances in )?neural information processing systems|neurips|nips|proceedings of the \d+(?:st|nd|rd|th) international conference on neural information processing systems)(?:[ ,:]*(?:\d{1,4}))?$/u.test(
      title,
    )
  ) {
    return new URL("https://neurips.cc/");
  }
  if (
    title &&
    /^(?:(?:cvpr)(?: \d{4})?|(?:(?:proceedings of the )?(?:ieee |ieee\/cvf )?(?:\d{4} )?(?:computer society )?conference on computer vision and pattern recognition|\d{4} (?:ieee |ieee\/cvf )?(?:computer society )?conference on computer vision and pattern recognition)(?: \(cvpr\))?)$/u.test(
      title,
    )
  ) {
    return new URL("https://cvpr.thecvf.com/");
  }
  return null;
}

async function registryJson(url: URL, hop: PublicHttpsHop, onAdmitted: () => void) {
  try {
    const lane = registryLanes.get(url.hostname);
    if (!lane) return null;
    return await lane(async () => {
      onAdmitted();
      const { body } = await requestPublicHttps({
        url: withRegistryContact(url),
        maxBytes: MAX_CROSSREF_BYTES,
        accept: "application/json",
        hop,
      });
      return JSON.parse(body.toString("utf8")) as unknown;
    });
  } catch {
    return null;
  }
}

async function venueHomepage(
  record: ScientSourceRecord,
  hop: PublicHttpsHop,
  onAdmitted: () => void,
): Promise<URL | null> {
  const conference = conferenceHomepage(record);
  if (conference) return conference;
  const issn = record.identifiers
    .filter(({ scheme }) => /^e?issn$/iu.test(scheme.trim()))
    .map(({ value }) => value.replace(/[-\s]/gu, "").toUpperCase())
    .find((value) => /^\d{7}[\dX]$/u.test(value));
  const url = new URL(
    issn ? `https://api.openalex.org/sources/issn:${issn}` : "https://api.openalex.org/sources",
  );
  url.searchParams.set("select", "display_name,issn,homepage_url,host_organization_name");
  if (!issn) {
    url.searchParams.set("search", record.containerTitle!.trim());
    url.searchParams.set("per-page", "100");
  }
  const response = object(await registryJson(url, hop, onAdmitted));
  if (!response) return null;
  const normalize = (title: string) =>
    title
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  const publisher = (value: string) => {
    const name = normalize(value).replace(/(?:bv|llc|ltd|inc|limited)$/u, "");
    if (/^(?:springer|springernature|springersciencebusinessmedia|biomedcentral)$/u.test(name))
      return "springer";
    return name.replace(/(?:publishing|publications|publishers|press)$/u, "");
  };
  if (
    !issn &&
    typeof object(response.meta)?.count === "number" &&
    Number(object(response.meta)!.count) > 100
  )
    return null;
  const candidates = issn
    ? [response]
    : Array.isArray(response.results)
      ? response.results
          .map(object)
          .filter(
            (source) =>
              typeof source?.display_name === "string" &&
              venueTitle(source.display_name) === venueTitle(record.containerTitle!) &&
              (!record.publisher?.trim() ||
                (typeof source.host_organization_name === "string" &&
                  publisher(source.host_organization_name) === publisher(record.publisher))),
          )
      : [];
  if (candidates.length !== 1) return null;
  const source = candidates[0];
  if (
    issn &&
    (!Array.isArray(source?.issn) ||
      !source.issn.some(
        (value) => typeof value === "string" && value.replace(/-/gu, "").toUpperCase() === issn,
      ))
  )
    return null;
  const homepage = parseEligiblePublicUrl(
    typeof source?.homepage_url === "string" ? source.homepage_url : null,
  );
  return homepage && platformMatchesVenue(homepage, record) ? homepage : null;
}

function publicAddress(address: string, family: number): boolean {
  if (family === 4) return !blockedAddresses.check(address, "ipv4");
  if (family === 6) {
    if (/^::ffff:/iu.test(address)) return false;
    return !blockedAddresses.check(address, "ipv6");
  }
  return false;
}

async function resolvePublicAddress(
  url: URL,
  signal?: AbortSignal,
): Promise<{ readonly address: string; readonly family: 4 | 6 }> {
  const literalFamily = NodeNet.isIP(url.hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!publicAddress(url.hostname, literalFamily))
      throw new Error("The icon host is not public.");
    return { address: url.hostname, family: literalFamily };
  }
  const addresses = await Promise.race([
    NodeDnsPromises.lookup(url.hostname, { all: true, verbatim: true }),
    NodeTimersPromises.setTimeout(ICON_REQUEST_TIMEOUT_MS, null, {
      ref: false,
      ...(signal ? { signal } : {}),
    }).then(() => {
      throw new Error("The icon host lookup timed out.");
    }),
  ]);
  if (
    addresses.length === 0 ||
    addresses.some((entry) => !publicAddress(entry.address, entry.family))
  ) {
    throw new Error("The icon host did not resolve exclusively to public addresses.");
  }
  const selected = addresses[0];
  if (!selected || (selected.family !== 4 && selected.family !== 6)) {
    throw new Error("The icon host did not resolve to a supported address.");
  }
  return { address: selected.address, family: selected.family };
}

const IMAGE_ACCEPT =
  "image/webp,image/png,image/jpeg,image/gif,image/x-icon,image/svg+xml,*/*;q=0.1";
const HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1";

const publicHttpsHop: PublicHttpsHop = async ({ url, accept, maxBytes, signal }) => {
  const target = await resolvePublicAddress(url, signal);
  const { promise, resolve, reject } = Promise.withResolvers<HopResponse>();
  const request = NodeHttps.request(
    {
      protocol: "https:",
      hostname: target.address,
      family: target.family,
      port: 443,
      method: "GET",
      path: `${url.pathname}${url.search}`,
      servername: url.hostname,
      ...(signal ? { signal } : {}),
      headers: {
        Accept: accept,
        Host: url.host,
        "User-Agent": USER_AGENT,
      },
    },
    (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location ?? null;
      if (status < 200 || status >= 300) {
        response.resume();
        resolve({ status, location, body: Buffer.alloc(0) });
        return;
      }
      const chunks: Buffer[] = [];
      let byteLength = 0;
      response.on("aborted", () => reject(new Error("The icon response was interrupted.")));
      response.on("error", reject);
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        byteLength += chunk.byteLength;
        if (byteLength <= maxBytes) return;
        resolve({
          status,
          location,
          body: Buffer.concat(chunks).subarray(0, maxBytes),
          truncated: true,
        });
        request.destroy();
      });
      response.on("end", () => resolve({ status, location, body: Buffer.concat(chunks) }));
    },
  );
  request.setTimeout(ICON_REQUEST_TIMEOUT_MS, () => {
    request.destroy(new Error("The icon request timed out."));
  });
  request.on("error", reject);
  request.end();
  return promise;
};

/**
 * Follows at most MAX_REDIRECTS standard-HTTPS redirects; returns the final address with the
 * body. A longer body is refused, or with `partial` kept up to maxBytes.
 */
async function requestPublicHttps(input: {
  readonly url: URL;
  readonly maxBytes: number;
  readonly accept: string;
  readonly hop: PublicHttpsHop;
  readonly partial?: boolean;
}): Promise<{ readonly url: URL; readonly body: Buffer }> {
  let url = input.url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (url.protocol !== "https:" || (url.port && url.port !== "443")) {
      throw new Error("Journal icon requests must use standard HTTPS.");
    }
    const response = await input.hop({ url, accept: input.accept, maxBytes: input.maxBytes });
    if (response.status >= 300 && response.status < 400 && response.location) {
      url = new URL(response.location, url);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`The icon host returned HTTP ${response.status}.`);
    }
    const tooLong = response.truncated === true || response.body.byteLength > input.maxBytes;
    if (tooLong && !input.partial) {
      throw new Error("The icon response was too large.");
    }
    return { url, body: tooLong ? response.body.subarray(0, input.maxBytes) : response.body };
  }
  throw new Error("The icon request redirected too many times.");
}

function inspectIcon(bytes: Uint8Array): IconFormat | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { extension: "png", mediaType: "image/png" };
  }
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    return { extension: "ico", mediaType: "image/vnd.microsoft.icon" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: "jpg", mediaType: "image/jpeg" };
  }
  const prefix = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
  if (prefix === "GIF87a" || prefix === "GIF89a") {
    return { extension: "gif", mediaType: "image/gif" };
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return { extension: "webp", mediaType: "image/webp" };
  }
  return null;
}

function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function attribute(element: HtmlElement, name: string): string | null {
  return element.attrs.find((candidate) => candidate.name.toLowerCase() === name)?.value ?? null;
}

function declaredIconSize(value: string | null, rel: ReadonlySet<string>, url: URL): number {
  const sizes =
    value?.split(/\s+/u).flatMap((size) => {
      const match = /^(\d+)x(\d+)$/iu.exec(size);
      return match ? [Math.min(Number(match[1] ?? 0), Number(match[2] ?? 0))] : [];
    }) ?? [];
  const explicit = Math.max(0, ...sizes);
  if (explicit > 0) return explicit;
  if (rel.has("apple-touch-icon") || rel.has("apple-touch-icon-precomposed")) return 180;
  if (/\.png(?:$|\?)/iu.test(url.href)) return 32;
  if (/\.ico(?:$|\?)/iu.test(url.href)) return 16;
  return 1;
}

function extractDeclaredIconCandidates(
  html: string,
  documentUrl: URL,
  authoritativePage = false,
): DeclaredIconCandidate[] {
  const documentDomain = getDomain(documentUrl.hostname, { allowPrivateDomains: true });
  if (!documentDomain) return [];
  const candidates = new Map<string, DeclaredIconCandidate>();
  const visit = (node: HtmlNode): void => {
    if (isElement(node) && node.tagName.toLowerCase() === "link") {
      const rel = new Set(
        (attribute(node, "rel") ?? "").toLowerCase().split(/\s+/u).filter(Boolean),
      );
      const href = attribute(node, "href");
      if (
        href &&
        (rel.has("icon") || rel.has("apple-touch-icon") || rel.has("apple-touch-icon-precomposed"))
      ) {
        try {
          const url = parseEligiblePublicUrl(new URL(href, documentUrl).href);
          const iconDomain = url ? getDomain(url.hostname, { allowPrivateDomains: true }) : null;
          if (url && (iconDomain === documentDomain || authoritativePage)) {
            const candidate = {
              declaredSize: declaredIconSize(attribute(node, "sizes"), rel, url),
              url,
              touchIcon: rel.has("apple-touch-icon") || rel.has("apple-touch-icon-precomposed"),
              branding: false,
            };
            const existing = candidates.get(url.href);
            if (!existing || existing.declaredSize < candidate.declaredSize) {
              candidates.set(url.href, candidate);
            }
          }
        } catch {
          // Ignore malformed declarations; the conventional favicon remains available.
        }
      }
    }
    if (
      isElement(node) &&
      node.tagName === "img" &&
      /(?:^|[\s_-])logo(?:$|[\s_-])/iu.test(
        `${attribute(node, "alt") ?? ""} ${attribute(node, "class") ?? ""}`,
      )
    ) {
      let parent: HtmlNode | undefined | null = node.parentNode;
      let inHeader = false;
      while (parent) {
        if (isElement(parent) && (parent.tagName === "header" || parent.tagName === "nav")) {
          inHeader = true;
          break;
        }
        parent = "parentNode" in parent ? parent.parentNode : null;
      }
      const src = attribute(node, "src");
      if (inHeader && src) {
        try {
          const url = parseEligiblePublicUrl(new URL(src, documentUrl).href);
          if (
            url &&
            getDomain(url.hostname, { allowPrivateDomains: true }) === documentDomain &&
            !candidates.has(url.href)
          ) {
            candidates.set(url.href, { url, declaredSize: 1, touchIcon: false, branding: true });
          }
        } catch {
          // A malformed logo must not prevent favicon discovery.
        }
      }
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(parse(html));
  return [...candidates.values()].toSorted(
    (left, right) =>
      Number(left.branding) - Number(right.branding) ||
      Number(left.touchIcon) - Number(right.touchIcon) ||
      right.declaredSize - left.declaredSize,
  );
}

type IconTransport = {
  readonly hop: PublicHttpsHop;
  readonly signal: AbortSignal;
  readonly images: Map<string, Promise<DownloadedIcon | null>>;
};

function sameSite(left: URL, right: URL): boolean {
  const domain = getDomain(left.hostname, { allowPrivateDomains: true });
  return domain
    ? domain === getDomain(right.hostname, { allowPrivateDomains: true })
    : left.hostname === right.hostname;
}

function venueTitle(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
}

function registryVenueMatches(value: unknown, record: ScientSourceRecord): boolean {
  const message = object(object(value)?.message);
  const normalizeIssn = (value: string) => value.replace(/[-\s]/gu, "").toUpperCase();
  const sourceIssns = record.identifiers
    .filter(({ scheme }) => /^e?issn$/iu.test(scheme.trim()))
    .map(({ value }) => normalizeIssn(value))
    .filter((value) => /^\d{7}[\dX]$/u.test(value));
  const registeredIssns = Array.isArray(message?.ISSN)
    ? message.ISSN.filter((value): value is string => typeof value === "string")
        .map(normalizeIssn)
        .filter((value) => /^\d{7}[\dX]$/u.test(value))
    : [];
  if (sourceIssns.length && registeredIssns.length)
    return registeredIssns.some((value) => sourceIssns.includes(value));
  const title = venueTitle(record.containerTitle ?? "");
  const titles = message?.["container-title"];
  return (
    !!title &&
    Array.isArray(titles) &&
    titles.some((value) => typeof value === "string" && venueTitle(value) === title)
  );
}

type IconDocument = {
  readonly url: URL;
  readonly body: Buffer;
};

function downloadRasterIcon(url: URL, transport: IconTransport): Promise<DownloadedIcon | null> {
  const previous = transport.images.get(url.href);
  if (previous) return previous;
  const download = fetchRasterIcon(url, transport);
  transport.images.set(url.href, download);
  return download;
}

async function fetchRasterIcon(url: URL, transport: IconTransport): Promise<DownloadedIcon | null> {
  try {
    const { body, url: finalUrl } = await requestPublicHttps({
      url,
      maxBytes: MAX_ICON_BYTES,
      accept: IMAGE_ACCEPT,
      hop: transport.hop,
    });
    if (!sameSite(finalUrl, url)) return null;
    const raster = inspectIcon(body);
    if (raster && !(await validateJournalRaster(body, transport.signal))) return null;
    const svg = raster ? null : await rasterizeJournalSvg(body, transport.signal);
    const format =
      raster ?? (svg ? { extension: "png" as const, mediaType: "image/png" as const } : null);
    return format ? { ...format, bytes: svg ?? body, sourceUrl: finalUrl.href } : null;
  } catch {
    return null;
  }
}

const preprintPlatforms: Readonly<Record<string, readonly string[]>> = {
  "arxiv.org": ["arxiv"],
  "biorxiv.org": ["biorxiv"],
  "medrxiv.org": ["medrxiv"],
  "ssrn.com": ["ssrn", "social science research network"],
  "researchsquare.com": ["research square"],
  "preprints.org": ["preprints", "preprints.org"],
};

function platformMatchesVenue(url: URL, record: ScientSourceRecord): boolean {
  const domain = getDomain(url.hostname, { allowPrivateDomains: true });
  const title = record.containerTitle
    ?.normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s*\([^)]*\)$/u, "")
    .trim();
  if (domain === "jstor.org") return false;
  const names = domain ? preprintPlatforms[domain] : undefined;
  return !names || (record.type === "preprint" && !!title && names.includes(title));
}

async function defaultResolveLandingUrl(
  record: ScientSourceRecord,
  hop: PublicHttpsHop,
  onAdmitted: () => void,
): Promise<URL | null> {
  const doi = sourceDoi(record);
  if (doi && (!doi.startsWith("10.48550/") || record.type === "preprint")) {
    const encodedDoi = doi.split("/").map(encodeURIComponent).join("/");
    const crossrefRecord = await registryJson(
      new URL(`https://api.crossref.org/works/${encodedDoi}`),
      hop,
      onAdmitted,
    );
    const crossref = crossrefLandingUrl(crossrefRecord);
    if (
      crossref &&
      registryVenueMatches(crossrefRecord, record) &&
      platformMatchesVenue(crossref, record)
    )
      return crossref;
    if (record.type !== "preprint") return null;
    const attributes = object(
      object(
        object(
          await registryJson(
            new URL(`https://api.datacite.org/dois/${encodedDoi}`),
            hop,
            onAdmitted,
          ),
        )?.data,
      )?.attributes,
    );
    const datacite = parseEligiblePublicUrl(
      typeof attributes?.url === "string" ? attributes.url : null,
    );
    if (datacite && platformMatchesVenue(datacite, record)) {
      const platform =
        preprintPlatforms[getDomain(datacite.hostname, { allowPrivateDomains: true }) ?? ""];
      if (
        platform ||
        (typeof attributes?.publisher === "string" &&
          venueTitle(attributes.publisher) === venueTitle(record.containerTitle ?? ""))
      )
        return datacite;
    }
  }
  // A user-supplied URL is paper evidence, not authority for every paper in its venue.
  return null;
}

/** Icons declared by a document, resolved against its address after redirects. */
async function declaredIconsOf(url: URL, transport: IconTransport): Promise<IconDocument | null> {
  try {
    // The icons are named in the head; a long article page is read only that far.
    const document = await requestPublicHttps({
      url,
      maxBytes: MAX_ICON_DOCUMENT_BYTES,
      accept: HTML_ACCEPT,
      hop: transport.hop,
      partial: true,
    });
    if (!sameSite(document.url, url)) return null;
    return { url: document.url, body: document.body };
  } catch {
    return null;
  }
}

async function downloadDeclaredIcon(
  candidates: readonly DeclaredIconCandidate[],
  transport: IconTransport,
): Promise<DownloadedIcon | null> {
  for (const candidate of candidates.slice(0, MAX_DECLARED_ICON_ATTEMPTS)) {
    const icon = await downloadRasterIcon(candidate.url, transport);
    if (icon) return icon;
  }
  return null;
}

async function defaultDownloadIcon(
  landingUrl: URL,
  transport: IconTransport,
  options: { readonly publisherFallback?: boolean; readonly document?: IconDocument | null } = {},
): Promise<DownloadedIcon | null> {
  const article =
    options.document !== undefined
      ? options.document
      : await declaredIconsOf(landingUrl, transport);
  const articleIcon = await downloadDeclaredIcon(
    article ? extractDeclaredIconCandidates(article.body.toString("utf8"), article.url, true) : [],
    transport,
  );
  if (articleIcon) return articleIcon;
  if (!options.publisherFallback) return null;
  // Never climb a university, repository or hosting domain to invent a publisher identity.
  return downloadRasterIcon(
    new URL("/favicon.ico", (article?.url ?? landingUrl).origin),
    transport,
  );
}

function validCacheMetadata(value: unknown): CacheMetadata | null {
  const candidate = object(value);
  const extension = candidate?.extension;
  const mediaType = candidate?.mediaType;
  const resolvedAt = candidate?.resolvedAt;
  const sourceHost = candidate?.sourceHost;
  const discoveryVersion =
    typeof candidate?.discoveryVersion === "number" ? candidate.discoveryVersion : 1;
  if (
    !candidate ||
    (extension !== "gif" &&
      extension !== "ico" &&
      extension !== "jpg" &&
      extension !== "png" &&
      extension !== "webp") ||
    (mediaType !== "image/gif" &&
      mediaType !== "image/jpeg" &&
      mediaType !== "image/png" &&
      mediaType !== "image/vnd.microsoft.icon" &&
      mediaType !== "image/webp") ||
    typeof resolvedAt !== "string" ||
    typeof sourceHost !== "string"
  ) {
    return null;
  }
  return {
    discoveryVersion,
    extension,
    mediaType,
    resolvedAt,
    sourceHost,
    ...(typeof candidate.artworkTitle === "string" ? { artworkTitle: candidate.artworkTitle } : {}),
    ...(typeof candidate.sourceUrl === "string" ? { sourceUrl: candidate.sourceUrl } : {}),
  };
}

async function readCachedIcon(input: {
  readonly cacheRoot: string;
  readonly key: string;
  readonly journalTitle: string;
  readonly now: Date;
  readonly record: ScientSourceRecord;
}): Promise<(JournalIconMaterial & { readonly fresh: boolean }) | null> {
  const directory = NodePath.join(input.cacheRoot, input.key);
  try {
    const metadata = validCacheMetadata(
      JSON.parse(
        await NodeFSP.readFile(NodePath.join(directory, "metadata.json"), "utf8"),
      ) as unknown,
    );
    if (!metadata || metadata.discoveryVersion !== ICON_DISCOVERY_VERSION) return null;
    if (!platformMatchesVenue(new URL(`https://${metadata.sourceHost}/`), input.record))
      return null;
    const absolutePath = NodePath.join(directory, `icon.${metadata.extension}`);
    const stat = await NodeFSP.stat(absolutePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ICON_BYTES) return null;
    return {
      absolutePath: await NodeFSP.realpath(absolutePath),
      cacheRoot: await NodeFSP.realpath(input.cacheRoot),
      journalTitle: metadata.artworkTitle ?? input.journalTitle,
      fresh:
        metadata.discoveryVersion === ICON_DISCOVERY_VERSION &&
        input.now.getTime() - Date.parse(metadata.resolvedAt) <= SUCCESS_TTL_MS,
    };
  } catch {
    return null;
  }
}

async function writeCachedIcon(input: {
  readonly cacheRoot: string;
  readonly key: string;
  readonly journalTitle: string;
  readonly landingUrl: URL;
  readonly icon: DownloadedIcon;
  readonly now: Date;
}): Promise<JournalIconMaterial> {
  const directory = NodePath.join(input.cacheRoot, input.key);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const iconPath = NodePath.join(directory, `icon.${input.icon.extension}`);
  const temporaryPath = `${iconPath}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temporaryPath, input.icon.bytes, { mode: 0o600 });
  await NodeFSP.rename(temporaryPath, iconPath);
  await NodeFSP.writeFile(
    NodePath.join(directory, "metadata.json.tmp"),
    `${JSON.stringify({
      discoveryVersion: ICON_DISCOVERY_VERSION,
      extension: input.icon.extension,
      mediaType: input.icon.mediaType,
      resolvedAt: input.now.toISOString(),
      sourceHost: input.landingUrl.hostname,
      ...(input.icon.sourceUrl ? { sourceUrl: input.icon.sourceUrl } : {}),
      ...(input.icon.artworkTitle ? { artworkTitle: input.icon.artworkTitle } : {}),
    } satisfies CacheMetadata)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await NodeFSP.rename(
    NodePath.join(directory, "metadata.json.tmp"),
    NodePath.join(directory, "metadata.json"),
  );
  return {
    absolutePath: await NodeFSP.realpath(iconPath),
    cacheRoot: await NodeFSP.realpath(input.cacheRoot),
    journalTitle: input.icon.artworkTitle ?? input.journalTitle,
  };
}

type RetryState = { readonly retryAfter: number; readonly attempts: number };
type FailureState = {
  readonly sources: Readonly<Record<string, RetryState>>;
  readonly venue?: RetryState;
  readonly homepageUrl?: string;
};

function validRetry(value: unknown): RetryState | undefined {
  const retry = object(value);
  return retry &&
    typeof retry.retryAfter === "number" &&
    Number.isFinite(retry.retryAfter) &&
    typeof retry.attempts === "number" &&
    Number.isInteger(retry.attempts) &&
    retry.attempts > 0 &&
    retry.attempts <= 16
    ? { retryAfter: retry.retryAfter, attempts: retry.attempts }
    : undefined;
}

async function readFailures(directory: string): Promise<FailureState> {
  try {
    const value = object(
      JSON.parse(await NodeFSP.readFile(NodePath.join(directory, "failure.json"), "utf8")),
    );
    if (value?.discoveryVersion !== ICON_DISCOVERY_VERSION) return { sources: {} };
    const entries = Object.entries(object(value.sources) ?? {}).slice(0, MAX_SOURCE_FAILURES);
    const sources = Object.fromEntries(
      entries.flatMap(([key, raw]) => {
        const retry = validRetry(raw);
        return /^[a-f0-9]{64}$/u.test(key) && retry ? [[key, retry]] : [];
      }),
    );
    const venue = validRetry(value.venue);
    const homepage = parseEligiblePublicUrl(
      typeof value.homepageUrl === "string" ? value.homepageUrl : null,
    );
    return {
      sources,
      ...(venue ? { venue } : {}),
      ...(homepage ? { homepageUrl: homepage.href } : {}),
    };
  } catch {
    return { sources: {} };
  }
}

function nextRetry(previous: RetryState | undefined, now: number): RetryState {
  const attempts = Math.min(16, (previous?.attempts ?? 0) + 1);
  return {
    attempts,
    retryAfter: now + Math.min(MAX_FAILURE_TTL_MS, FAILURE_TTL_MS * 2 ** (attempts - 1)),
  };
}

async function discover(input: {
  readonly record: ScientSourceRecord;
  readonly cacheRoot: string;
  readonly key: string;
  readonly journalTitle: string;
  readonly requestKey: string;
  readonly failures: FailureState;
  readonly options: JournalIconResolverOptions;
}): Promise<JournalIconMaterial | null> {
  const controller = new AbortController();
  const specificController = new AbortController();
  const publisherCandidates = publisherArtworkCandidates(input.record);
  const { promise: deadline, resolve: finishDeadline } =
    Promise.withResolvers<JournalIconMaterial | null>();
  let timer: NodeJS.Timeout | undefined;
  let specificTimer: NodeJS.Timeout | undefined;
  const startDeadline = () => {
    if (timer) return;
    timer = NodeTimers.setTimeout(() => {
      controller.abort();
      finishDeadline(null);
    }, ICON_DISCOVERY_TIMEOUT_MS);
    timer.unref();
    // Reserve time for an honest publisher fallback after blocked article sites.
    if (publisherCandidates.length) {
      specificTimer = NodeTimers.setTimeout(() => specificController.abort(), 3_500);
      specificTimer.unref();
    }
  };
  const signal = controller.signal;
  const rawHop = input.options.httpsHop ?? publicHttpsHop;
  const exchanges = new Map<string, Promise<HopResponse>>();
  const makeHop =
    (requestSignal: AbortSignal): PublicHttpsHop =>
    (request) => {
      requestSignal.throwIfAborted();
      const key = JSON.stringify([request.url.href, request.accept, request.maxBytes]);
      const previous = exchanges.get(key);
      if (previous) return previous;
      const response = Promise.resolve().then(() => rawHop({ ...request, signal: requestSignal }));
      exchanges.set(key, response);
      return response;
    };
  const hop = makeHop(signal);
  const specificSignal = AbortSignal.any([signal, specificController.signal]);
  const specificHop = makeHop(specificSignal);
  const images = new Map<string, Promise<DownloadedIcon | null>>();
  const specific: IconTransport = { hop: specificHop, signal: specificSignal, images };
  const general: IconTransport = { hop, signal, images };
  const canTryVenue =
    (input.failures.venue?.retryAfter ?? 0) <= (input.options.now?.() ?? new Date()).getTime();
  let triedVenue = false;
  let verifiedHomepage = parseEligiblePublicUrl(input.failures.homepageUrl ?? null);
  const operation = async () => {
    const automatic = !input.options.resolveLandingUrl && !input.options.downloadIcon;
    const knownConference = conferenceHomepage(input.record);
    let homepage = knownConference ?? verifiedHomepage;
    let landingUrl: URL | null = null;
    let icon: DownloadedIcon | null = null;
    if (automatic && knownConference && canTryVenue) {
      verifiedHomepage = knownConference;
      triedVenue = true;
      startDeadline();
      icon = await defaultDownloadIcon(knownConference, specific);
      if (icon) landingUrl = knownConference;
    }
    if (!icon) {
      if (input.options.resolveLandingUrl) startDeadline();
      landingUrl = await (input.options.resolveLandingUrl
        ? input.options.resolveLandingUrl(input.record)
        : input.options.downloadIcon
          ? (parseEligiblePublicUrl(input.record.url) ??
            (await defaultResolveLandingUrl(input.record, specificHop, startDeadline)))
          : await defaultResolveLandingUrl(input.record, specificHop, startDeadline));
      signal.throwIfAborted();
      if (automatic) {
        // Prefetch the canonical page, but do not download its artwork before verifying its owner.
        const document = landingUrl ? declaredIconsOf(landingUrl, specific) : null;
        const publisherLanding = landingUrl && publisherControlsWebsite(input.record, landingUrl);
        if (
          canTryVenue &&
          !knownConference &&
          !publisherLanding &&
          !(input.record.type === "preprint" && landingUrl)
        ) {
          homepage = await venueHomepage(input.record, specificHop, () => {
            triedVenue = true;
            startDeadline();
          });
          verifiedHomepage = homepage;
        }
        const ownedLanding =
          landingUrl &&
          (input.record.type === "preprint" ||
            (homepage && sameSite(landingUrl, homepage)) ||
            publisherLanding);
        if (landingUrl && ownedLanding) {
          startDeadline();
          icon = await defaultDownloadIcon(landingUrl, specific, { document: await document });
        } else {
          landingUrl = null;
        }
        if (!icon && homepage && canTryVenue && !knownConference) {
          triedVenue = true;
          startDeadline();
          const document = await declaredIconsOf(homepage, specific);
          if (document) homepage = document.url;
          icon = await defaultDownloadIcon(homepage, specific, { document });
          if (icon) landingUrl = homepage;
        }
      } else if (landingUrl) {
        startDeadline();
        icon = await (input.options.downloadIcon
          ? input.options.downloadIcon(landingUrl)
          : defaultDownloadIcon(landingUrl, specific));
      }
    }
    NodeTimers.clearTimeout(specificTimer);
    if (!icon && automatic && canTryVenue) {
      triedVenue = true;
      startDeadline();
      // A canonical paper URL can still be a forwarding hub. Its undeclared
      // /favicon.ico is not venue evidence; only a verified venue gets this fallback.
      const sites = homepage ? [homepage] : [];
      const fallbacks = [
        ...venueArtworkCandidates(input.record).map(async (candidate) => {
          const found = await downloadRasterIcon(candidate.url, general);
          return found
            ? {
                icon: {
                  ...found,
                  artworkTitle: `${input.journalTitle} (${candidate.publisher} publisher icon)`,
                },
                page: candidate.url,
              }
            : null;
        }),
        ...sites.map(async (page) => {
          const found = await downloadRasterIcon(new URL("/favicon.ico", page.origin), general);
          return found ? { icon: found, page } : null;
        }),
        ...publisherCandidates.map(async (candidate) => {
          const found = await (candidate.kind === "image"
            ? downloadRasterIcon(candidate.url, general)
            : defaultDownloadIcon(candidate.url, general, { publisherFallback: true }));
          return found
            ? {
                icon: {
                  ...found,
                  artworkTitle: `${input.journalTitle} (${candidate.publisher} publisher icon)`,
                },
                page: candidate.url,
              }
            : null;
        }),
      ];
      for (const pending of fallbacks) {
        const fallback = await pending.catch(() => null);
        if (fallback) {
          icon = fallback.icon;
          landingUrl = fallback.page;
          break;
        }
      }
    }
    signal.throwIfAborted();
    if (!icon || !landingUrl) return null;
    if (icon.sourceUrl && !icon.artworkTitle) {
      icon = {
        ...icon,
        artworkTitle: `${input.journalTitle} (${new URL(icon.sourceUrl).hostname} website icon)`,
      };
    }
    return writeCachedIcon({
      ...input,
      landingUrl,
      icon,
      now: input.options.now?.() ?? new Date(),
    });
  };
  const directory = NodePath.join(input.cacheRoot, input.key);
  try {
    const result = await Promise.race([operation(), deadline]);
    if (result) {
      await NodeFSP.rm(NodePath.join(directory, "failure.json"), { force: true }).catch(
        () => undefined,
      );
      return result;
    }
  } catch {
    // Discovery is optional; a publisher failure never removes verified cached artwork.
  } finally {
    controller.abort();
    NodeTimers.clearTimeout(timer);
    NodeTimers.clearTimeout(specificTimer);
  }
  const now = (input.options.now?.() ?? new Date()).getTime();
  const sources = Object.fromEntries([
    ...Object.entries(input.failures.sources)
      .filter(([key]) => key !== input.requestKey)
      .sort(([, left], [, right]) => right.retryAfter - left.retryAfter)
      .slice(0, MAX_SOURCE_FAILURES - 1),
    [input.requestKey, nextRetry(input.failures.sources[input.requestKey], now)],
  ]);
  const venue = triedVenue ? nextRetry(input.failures.venue, now) : input.failures.venue;
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  await NodeFSP.writeFile(
    NodePath.join(directory, "failure.json.tmp"),
    JSON.stringify({
      discoveryVersion: ICON_DISCOVERY_VERSION,
      sources,
      ...(verifiedHomepage ? { homepageUrl: verifiedHomepage.href } : {}),
      ...(venue ? { venue } : {}),
    }),
    { mode: 0o600 },
  );
  await NodeFSP.rename(
    NodePath.join(directory, "failure.json.tmp"),
    NodePath.join(directory, "failure.json"),
  );
  return null;
}

export async function resolveJournalIcon(input: {
  readonly record: ScientSourceRecord;
  readonly cacheRoot: string;
  readonly options?: JournalIconResolverOptions;
}): Promise<JournalIconMaterial | null> {
  const journalTitle = input.record.containerTitle?.trim();
  const identity = journalIconIdentity(input.record);
  if (!journalTitle || !identity) return null;
  const key = NodeCrypto.createHash("sha256").update(identity).digest("hex");
  const requestKey = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([input.record.url, input.record.identifiers]))
    .digest("hex");
  const now = input.options?.now?.() ?? new Date();
  const cached = await readCachedIcon({ ...input, key, journalTitle, now });
  const material = cached
    ? {
        absolutePath: cached.absolutePath,
        cacheRoot: cached.cacheRoot,
        journalTitle: cached.journalTitle,
      }
    : null;
  if (cached?.fresh) return material;
  const failures = await readFailures(NodePath.join(input.cacheRoot, key));
  const retryAfter = failures.sources[requestKey]?.retryAfter ?? 0;
  if (retryAfter > now.getTime()) return material;
  const sourceRetries = Object.values(failures.sources);
  if (
    !failures.sources[requestKey] &&
    sourceRetries.length >= MAX_SOURCE_FAILURES &&
    sourceRetries.every((retry) => retry.retryAfter > now.getTime())
  )
    return material;
  const activeKey = `${NodePath.resolve(input.cacheRoot)}\0${key}`;
  const active = activeResolutions.get(activeKey);
  if (active) {
    if (material) return material;
    const resolved = await active.promise;
    if (resolved || active.requestKey === requestKey) return resolved;
    return resolveJournalIcon(input);
  }
  const resolution = discover({
    ...input,
    key,
    requestKey,
    failures,
    journalTitle,
    options: input.options ?? {},
  })
    .catch(() => null)
    .finally(() => activeResolutions.delete(activeKey));
  activeResolutions.set(activeKey, { requestKey, promise: resolution });
  return material ?? resolution;
}

export const journalIconResolverInternals = {
  crossrefLandingUrl,
  extractDeclaredIconCandidates,
  inspectIcon,
  isIntermediaryHost,
  parseEligiblePublicUrl,
  publicAddress,
  requestPublicHttps,
};
