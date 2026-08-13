// @effect-diagnostics nodeBuiltinImport:off -- Journal icons are fetched and cached by the host.
// @effect-diagnostics globalDate:off -- Cache freshness is based on filesystem timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import {
  normalizePersistentIdentifier,
  type ScientSourceRecord,
} from "@scientfactory/scient-sources";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { getDomain } from "tldts";

const ICON_REQUEST_TIMEOUT_MS = 2_000;
const MAX_ICON_BYTES = 128 * 1024;
const MAX_ICON_DOCUMENT_BYTES = 512 * 1024;
const MAX_CROSSREF_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const MAX_DECLARED_ICON_ATTEMPTS = 2;
const ICON_DISCOVERY_VERSION = 2;
const SUCCESS_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const FAILURE_TTL_MS = 6 * 60 * 60 * 1_000;
const USER_AGENT =
  "Scient/0.0 (https://github.com/ScientFactory/scient-desktop-next; journal icon resolution)";

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

type DownloadedIcon = IconFormat & { readonly bytes: Uint8Array };

type CacheMetadata = IconFormat & {
  readonly discoveryVersion: 1 | 2;
  readonly resolvedAt: string;
  readonly sourceHost: string;
};

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

type DeclaredIconCandidate = {
  readonly declaredSize: number;
  readonly url: URL;
};

export interface JournalIconMaterial {
  readonly absolutePath: string;
  readonly cacheRoot: string;
  readonly journalTitle: string;
}

export interface JournalIconResolverOptions {
  readonly now?: () => Date;
  readonly resolveLandingUrl?: (record: ScientSourceRecord) => Promise<URL | null>;
  readonly downloadIcon?: (landingUrl: URL) => Promise<DownloadedIcon | null>;
}

const failedUntil = new Map<string, number>();
const activeResolutions = new Map<string, Promise<JournalIconMaterial | null>>();

function isIntermediaryHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  return intermediaryHosts.some((host) => normalized === host || normalized.endsWith(`.${host}`));
}

function parseEligiblePublicUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
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
  const resource = object(message?.resource);
  const primary = object(resource?.primary);
  const candidate =
    typeof primary?.URL === "string"
      ? primary.URL
      : typeof message?.URL === "string"
        ? message.URL
        : null;
  return parseEligiblePublicUrl(candidate);
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
): Promise<{ readonly address: string; readonly family: 4 | 6 }> {
  const literalFamily = NodeNet.isIP(url.hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (!publicAddress(url.hostname, literalFamily))
      throw new Error("The icon host is not public.");
    return { address: url.hostname, family: literalFamily };
  }
  const addresses = await Promise.race([
    NodeDnsPromises.lookup(url.hostname, { all: true, verbatim: true }),
    NodeTimersPromises.setTimeout(ICON_REQUEST_TIMEOUT_MS, null, { ref: false }).then(() => {
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

async function requestPublicHttps(
  url: URL,
  maxBytes: number,
  redirects = 0,
  accept = "image/avif,image/webp,image/png,image/jpeg,image/gif,image/x-icon,application/json;q=0.8,*/*;q=0.1",
): Promise<Buffer> {
  if (url.protocol !== "https:" || (url.port && url.port !== "443")) {
    throw new Error("Journal icon requests must use standard HTTPS.");
  }
  if (redirects > MAX_REDIRECTS) throw new Error("The icon request redirected too many times.");
  const target = await resolvePublicAddress(url);
  return new Promise((resolve, reject) => {
    const request = NodeHttps.request(
      {
        protocol: "https:",
        hostname: target.address,
        family: target.family,
        port: 443,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        servername: url.hostname,
        headers: {
          Accept: accept,
          Host: url.host,
          "User-Agent": USER_AGENT,
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          let redirected: URL;
          try {
            redirected = new URL(location, url);
          } catch (cause) {
            reject(cause);
            return;
          }
          void requestPublicHttps(redirected, maxBytes, redirects + 1, accept).then(
            resolve,
            reject,
          );
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`The icon host returned HTTP ${status}.`));
          return;
        }
        const declaredLength = Number(response.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          response.resume();
          reject(new Error("The icon response was too large."));
          return;
        }
        const chunks: Buffer[] = [];
        let byteLength = 0;
        response.on("aborted", () => reject(new Error("The icon response was interrupted.")));
        response.on("error", reject);
        response.on("data", (chunk: Buffer) => {
          byteLength += chunk.byteLength;
          if (byteLength > maxBytes) {
            request.destroy(new Error("The icon response was too large."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
      },
    );
    request.setTimeout(ICON_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("The icon request timed out."));
    });
    request.on("error", reject);
    request.end();
  });
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

function iconPixelSize(bytes: Uint8Array): number | null {
  const buffer = Buffer.from(bytes);
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return width > 0 && height > 0 ? Math.min(width, height) : null;
  }
  const prefix = buffer.subarray(0, 6).toString("ascii");
  if (buffer.length >= 10 && (prefix === "GIF87a" || prefix === "GIF89a")) {
    const width = buffer.readUInt16LE(6);
    const height = buffer.readUInt16LE(8);
    return width > 0 && height > 0 ? Math.min(width, height) : null;
  }
  if (
    buffer.length >= 6 &&
    buffer[0] === 0 &&
    buffer[1] === 0 &&
    buffer[2] === 1 &&
    buffer[3] === 0
  ) {
    const count = Math.min(buffer.readUInt16LE(4), 32);
    let largest = 0;
    for (let index = 0; index < count; index += 1) {
      const offset = 6 + index * 16;
      if (offset + 1 >= buffer.length) break;
      const width = buffer[offset] === 0 ? 256 : (buffer[offset] ?? 0);
      const height = buffer[offset + 1] === 0 ? 256 : (buffer[offset + 1] ?? 0);
      largest = Math.max(largest, Math.min(width, height));
    }
    return largest || null;
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

function extractDeclaredIconCandidates(html: string, documentUrl: URL): DeclaredIconCandidate[] {
  const documentDomain = getDomain(documentUrl.hostname, { allowPrivateDomains: false });
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
          const iconDomain = url ? getDomain(url.hostname, { allowPrivateDomains: false }) : null;
          if (url && iconDomain === documentDomain && !/\.svg(?:$|\?)/iu.test(url.href)) {
            const candidate = {
              declaredSize: declaredIconSize(attribute(node, "sizes"), rel, url),
              url,
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
    if ("childNodes" in node) {
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(parse(html));
  return [...candidates.values()].toSorted((left, right) => right.declaredSize - left.declaredSize);
}

function publisherRootUrl(landingUrl: URL): URL {
  const domain = getDomain(landingUrl.hostname, { allowPrivateDomains: false });
  return domain ? new URL(`https://${domain}/`) : new URL("/", landingUrl.origin);
}

function preferredIcon(
  current: DownloadedIcon | null,
  candidate: DownloadedIcon | null,
): DownloadedIcon | null {
  if (!current) return candidate;
  if (!candidate) return current;
  const currentSize = iconPixelSize(current.bytes) ?? 0;
  const candidateSize = iconPixelSize(candidate.bytes) ?? 0;
  return candidateSize > currentSize ? candidate : current;
}

async function downloadRasterIcon(url: URL): Promise<DownloadedIcon | null> {
  try {
    const response = await requestPublicHttps(url, MAX_ICON_BYTES);
    const format = inspectIcon(response);
    return format ? { ...format, bytes: response } : null;
  } catch {
    return null;
  }
}

async function defaultResolveLandingUrl(record: ScientSourceRecord): Promise<URL | null> {
  const direct = parseEligiblePublicUrl(record.url);
  if (direct) return direct;
  const doi = sourceDoi(record);
  if (!doi) return null;
  try {
    const encodedDoi = doi.split("/").map(encodeURIComponent).join("/");
    const response = await requestPublicHttps(
      new URL(`https://api.crossref.org/works/${encodedDoi}`),
      MAX_CROSSREF_BYTES,
      0,
      "application/json",
    );
    return crossrefLandingUrl(JSON.parse(response.toString("utf8")) as unknown);
  } catch {
    return null;
  }
}

async function defaultDownloadIcon(landingUrl: URL): Promise<DownloadedIcon | null> {
  const conventionalIcon = downloadRasterIcon(new URL("/favicon.ico", landingUrl.origin));
  const rootUrl = publisherRootUrl(landingUrl);
  const candidates = requestPublicHttps(
    rootUrl,
    MAX_ICON_DOCUMENT_BYTES,
    0,
    "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
  )
    .then((html) => extractDeclaredIconCandidates(html.toString("utf8"), rootUrl))
    .catch(() => []);
  let best = await conventionalIcon;
  for (const candidate of (await candidates).slice(0, MAX_DECLARED_ICON_ATTEMPTS)) {
    best = preferredIcon(best, await downloadRasterIcon(candidate.url));
  }
  return best;
}

function cacheKey(record: ScientSourceRecord, landingUrl: URL): string {
  const journalTitle = record.containerTitle?.trim().toLocaleLowerCase("en-US") ?? "";
  const issns = record.identifiers
    .filter((identifier) => identifier.scheme.trim().toLowerCase() === "issn")
    .map((identifier) => identifier.value.trim().toLowerCase())
    .toSorted()
    .join("|");
  return NodeCrypto.createHash("sha256")
    .update(`v1\0${issns}\0${journalTitle}\0${landingUrl.hostname.toLowerCase()}`)
    .digest("hex");
}

function requestKey(record: ScientSourceRecord, cacheRoot: string): string {
  const journalTitle = record.containerTitle?.trim().toLocaleLowerCase("en-US") ?? "";
  const issns = record.identifiers
    .filter((identifier) => identifier.scheme.trim().toLowerCase() === "issn")
    .map((identifier) => identifier.value.trim().toLowerCase())
    .toSorted()
    .join("|");
  const directHost = parseEligiblePublicUrl(record.url)?.hostname.toLowerCase() ?? "";
  return NodeCrypto.createHash("sha256")
    .update(`v1\0${cacheRoot}\0${issns}\0${journalTitle}\0${directHost}`)
    .digest("hex");
}

function validCacheMetadata(value: unknown): CacheMetadata | null {
  const candidate = object(value);
  const extension = candidate?.extension;
  const mediaType = candidate?.mediaType;
  const resolvedAt = candidate?.resolvedAt;
  const sourceHost = candidate?.sourceHost;
  const discoveryVersion = candidate?.discoveryVersion === ICON_DISCOVERY_VERSION ? 2 : 1;
  if (
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
  return { discoveryVersion, extension, mediaType, resolvedAt, sourceHost };
}

async function readCachedIcon(input: {
  readonly cacheRoot: string;
  readonly key: string;
  readonly journalTitle: string;
  readonly now: Date;
}): Promise<(JournalIconMaterial & { readonly fresh: boolean }) | null> {
  const directory = NodePath.join(input.cacheRoot, input.key);
  try {
    const metadata = validCacheMetadata(
      JSON.parse(
        await NodeFSP.readFile(NodePath.join(directory, "metadata.json"), "utf8"),
      ) as unknown,
    );
    if (!metadata) return null;
    const absolutePath = NodePath.join(directory, `icon.${metadata.extension}`);
    const stat = await NodeFSP.stat(absolutePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ICON_BYTES) return null;
    return {
      absolutePath: await NodeFSP.realpath(absolutePath),
      cacheRoot: await NodeFSP.realpath(input.cacheRoot),
      journalTitle: input.journalTitle,
      fresh:
        metadata.discoveryVersion === ICON_DISCOVERY_VERSION &&
        input.now.getTime() - stat.mtimeMs <= SUCCESS_TTL_MS,
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
    NodePath.join(directory, "metadata.json"),
    `${JSON.stringify({
      discoveryVersion: ICON_DISCOVERY_VERSION,
      extension: input.icon.extension,
      mediaType: input.icon.mediaType,
      resolvedAt: input.now.toISOString(),
      sourceHost: input.landingUrl.hostname,
    } satisfies CacheMetadata)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return {
    absolutePath: await NodeFSP.realpath(iconPath),
    cacheRoot: await NodeFSP.realpath(input.cacheRoot),
    journalTitle: input.journalTitle,
  };
}

async function resolveUncached(input: {
  readonly record: ScientSourceRecord;
  readonly cacheRoot: string;
  readonly options: JournalIconResolverOptions;
}): Promise<JournalIconMaterial | null> {
  const journalTitle = input.record.containerTitle?.trim();
  if (!journalTitle || input.record.type !== "article") return null;
  const resolveLandingUrl = input.options.resolveLandingUrl ?? defaultResolveLandingUrl;
  const downloadIcon = input.options.downloadIcon ?? defaultDownloadIcon;
  const landingUrl = await resolveLandingUrl(input.record);
  if (!landingUrl) return null;
  const key = cacheKey(input.record, landingUrl);
  const now = input.options.now?.() ?? new Date();
  await NodeFSP.mkdir(input.cacheRoot, { recursive: true, mode: 0o700 });
  const cached = await readCachedIcon({
    cacheRoot: input.cacheRoot,
    key,
    journalTitle,
    now,
  });
  if (cached?.fresh) {
    const { fresh: _fresh, ...material } = cached;
    return material;
  }
  const failureKey = `${input.cacheRoot}\0${key}`;
  if ((failedUntil.get(failureKey) ?? 0) > now.getTime()) {
    if (!cached) return null;
    const { fresh: _fresh, ...material } = cached;
    return material;
  }
  const icon = await downloadIcon(landingUrl);
  if (!icon) {
    failedUntil.set(failureKey, now.getTime() + FAILURE_TTL_MS);
    if (!cached) return null;
    const { fresh: _fresh, ...material } = cached;
    return material;
  }
  failedUntil.delete(failureKey);
  return writeCachedIcon({
    cacheRoot: input.cacheRoot,
    key,
    journalTitle,
    landingUrl,
    icon,
    now,
  });
}

export async function resolveJournalIcon(input: {
  readonly record: ScientSourceRecord;
  readonly cacheRoot: string;
  readonly options?: JournalIconResolverOptions;
}): Promise<JournalIconMaterial | null> {
  const title = input.record.containerTitle?.trim();
  if (!title || input.record.type !== "article") return null;
  const directUrl = parseEligiblePublicUrl(input.record.url);
  const doi = sourceDoi(input.record);
  if (!directUrl && !doi) return null;
  const activeKey = requestKey(input.record, input.cacheRoot);
  const active = activeResolutions.get(activeKey);
  if (active) return active;
  const resolution = resolveUncached({
    record: input.record,
    cacheRoot: input.cacheRoot,
    options: input.options ?? {},
  })
    .catch(() => null)
    .finally(() => activeResolutions.delete(activeKey));
  activeResolutions.set(activeKey, resolution);
  return resolution;
}

export const journalIconResolverInternals = {
  crossrefLandingUrl,
  extractDeclaredIconCandidates,
  iconPixelSize,
  inspectIcon,
  isIntermediaryHost,
  parseEligiblePublicUrl,
  preferredIcon,
  publicAddress,
  publisherRootUrl,
};
