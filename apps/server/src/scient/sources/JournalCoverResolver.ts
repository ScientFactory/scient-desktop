// @effect-diagnostics nodeBuiltinImport:off -- Journal covers are fetched and cached by the host.
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

import { shrinkJournalCover } from "./JournalCoverImage.ts";
import { MAX_COVER_INPUT_BYTES, MAX_COVER_OUTPUT_BYTES } from "./JournalCoverImageWorker.ts";

const COVER_REQUEST_TIMEOUT_MS = 5_000;
const COVER_DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const MAX_CANDIDATES = 4;
const COVER_VERSION = 1;
const SUCCESS_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const FAILURE_TTL_MS = 60_000;
const MAX_FAILURE_TTL_MS = 24 * 60 * 60 * 1_000;
const USER_AGENT =
  "Scient/0.0 (https://github.com/ScientFactory/scient-desktop; journal cover lookup)";

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

/** Publisher hosts that serve covers; a redirect anywhere else is refused. */
const coverHosts = new Set([
  "ars.els-cdn.com",
  "onlinelibrary.wiley.com",
  "media.springernature.com",
  "www.science.org",
  "www.pnas.org",
  "www.healthaffairs.org",
  "www.acpjournals.org",
  "www.nejm.org",
  "www.ahajournals.org",
  "pubs.rsna.org",
]);

export interface JournalCoverMaterial {
  readonly absolutePath: string;
  readonly cacheRoot: string;
  readonly journalTitle: string;
}

type HopResponse = {
  readonly status: number;
  readonly location: string | null;
  readonly body: Buffer;
  readonly truncated?: boolean;
};

/** One HTTPS exchange that never follows redirects; the default pins a verified public address. */
export type PublicHttpsHop = (input: {
  readonly url: URL;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}) => Promise<HopResponse>;

export interface JournalCoverResolverOptions {
  readonly now?: () => Date;
  readonly httpsHop?: PublicHttpsHop;
  readonly shrink?: (bytes: Buffer, signal?: AbortSignal) => Promise<Buffer | null>;
}

const activeResolutions = new Map<string, Promise<JournalCoverMaterial | null>>();

function sourceDoi(record: ScientSourceRecord): string | null {
  const doi = record.identifiers.find(
    (identifier) => identifier.scheme.trim().toLowerCase() === "doi",
  );
  if (!doi) return null;
  const normalized = normalizePersistentIdentifier("doi", doi.value);
  return normalized.startsWith("doi:") ? normalized.slice(4).toLowerCase() : null;
}

/** The record's ISSNs, then one embedded in an older Wiley or Elsevier DOI (`j.1553-2712.…`, `S0140-6736(…)`). */
function sourceIssns(record: ScientSourceRecord, doi: string | null): readonly string[] {
  const embedded = doi?.match(/^10\.\d+\/(?:j\.|s)(\d{4}-\d{3}[\dx])[.(]/u)?.[1];
  return [
    ...new Set(
      [
        ...record.identifiers
          .filter(({ scheme }) => /^e?issn$/iu.test(scheme.trim()))
          .map(({ value }) => value),
        ...(embedded ? [embedded] : []),
      ]
        .map((value) => value.replace(/[-\s]/gu, "").toUpperCase())
        .filter((value) => /^\d{7}[\dX]$/u.test(value)),
    ),
  ];
}

const normalized = (value: string | null) =>
  (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.:]/gu, "")
    .replace(/^the\s+/u, "")
    .replace(/\s+/gu, " ")
    .trim();

const elsevierPrefixes = new Set(["10.1016", "10.1053", "10.1054", "10.1067", "10.1078"]);
const wileyPrefixes = new Set(["10.1002", "10.1111", "10.1113", "10.1155"]);

/** Atypon sites serve the current issue cover by a journal code taken from the journal's title. */
const atyponCodes: Readonly<Record<string, readonly [host: string, code: string]>> = {
  science: ["www.science.org", "science"],
  "science advances": ["www.science.org", "sciadv"],
  "science translational medicine": ["www.science.org", "stm"],
  "science immunology": ["www.science.org", "sciimmunol"],
  "science robotics": ["www.science.org", "scirobotics"],
  "science signaling": ["www.science.org", "scisignal"],
  "proceedings of the national academy of sciences": ["www.pnas.org", "pnas"],
  "proceedings of the national academy of sciences of the united states of america": [
    "www.pnas.org",
    "pnas",
  ],
  pnas: ["www.pnas.org", "pnas"],
  "pnas nexus": ["www.pnas.org", "pnasnexus"],
  "health affairs": ["www.healthaffairs.org", "hlthaff"],
  "annals of internal medicine": ["www.acpjournals.org", "aim"],
  "nejm evidence": ["www.nejm.org", "evid"],
  "nejm ai": ["www.nejm.org", "aioa"],
  radiology: ["pubs.rsna.org", "radiology"],
  circulation: ["www.ahajournals.org", "circ"],
  "circulation research": ["www.ahajournals.org", "res"],
  stroke: ["www.ahajournals.org", "str"],
  hypertension: ["www.ahajournals.org", "hyp"],
  "arteriosclerosis, thrombosis, and vascular biology": ["www.ahajournals.org", "atvb"],
  "journal of the american heart association": ["www.ahajournals.org", "jaha"],
};

/** Where each publisher serves the journal's current cover, most specific first. */
export function journalCoverCandidates(record: ScientSourceRecord): readonly URL[] {
  if (!["article", "conference-paper"].includes(record.type)) return [];
  const doi = sourceDoi(record);
  const prefix = doi?.split("/")[0] ?? "";
  const publisher = normalized(record.publisher);
  const issns = sourceIssns(record, doi);
  const candidates: URL[] = [];
  const springer = doi?.match(/^10\.(?:1007|1038|1186)\/s(\d{5})-/u);
  if (springer) {
    candidates.push(
      new URL(
        `https://media.springernature.com/w300/springer-static/cover/journal/${Number(springer[1])}.jpg`,
      ),
    );
  }
  const atypon = atyponCodes[normalized(record.containerTitle)];
  if (atypon) {
    candidates.push(new URL(`https://${atypon[0]}/action/showCoverImage?journalCode=${atypon[1]}`));
  }
  if (elsevierPrefixes.has(prefix) || publisher.includes("elsevier")) {
    for (const issn of issns) {
      candidates.push(new URL(`https://ars.els-cdn.com/content/image/X${issn}.jpg`));
    }
  }
  if (wileyPrefixes.has(prefix) || publisher.includes("wiley")) {
    for (const issn of issns) {
      candidates.push(
        new URL(`https://onlinelibrary.wiley.com/action/showCoverImage?journalCode=${issn}`),
      );
    }
  }
  return candidates.slice(0, MAX_CANDIDATES);
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
  const addresses = await Promise.race([
    NodeDnsPromises.lookup(url.hostname, { all: true, verbatim: true }),
    NodeTimersPromises.setTimeout(COVER_REQUEST_TIMEOUT_MS, null, {
      ref: false,
      ...(signal ? { signal } : {}),
    }).then(() => {
      throw new Error("The cover host lookup timed out.");
    }),
  ]);
  if (
    addresses.length === 0 ||
    addresses.some((entry) => !publicAddress(entry.address, entry.family))
  ) {
    throw new Error("The cover host did not resolve exclusively to public addresses.");
  }
  const selected = addresses[0];
  if (!selected || (selected.family !== 4 && selected.family !== 6)) {
    throw new Error("The cover host did not resolve to a supported address.");
  }
  return { address: selected.address, family: selected.family };
}

const publicHttpsHop: PublicHttpsHop = async ({ url, maxBytes, signal }) => {
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
        Accept: "image/webp,image/png,image/jpeg,image/gif,*/*;q=0.1",
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
      response.on("aborted", () => reject(new Error("The cover response was interrupted.")));
      response.on("error", reject);
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        byteLength += chunk.byteLength;
        if (byteLength <= maxBytes) return;
        resolve({ status, location, body: Buffer.alloc(0), truncated: true });
        request.destroy();
      });
      response.on("end", () => resolve({ status, location, body: Buffer.concat(chunks) }));
    },
  );
  request.setTimeout(COVER_REQUEST_TIMEOUT_MS, () => {
    request.destroy(new Error("The cover request timed out."));
  });
  request.on("error", reject);
  request.end();
  return promise;
};

/** Follows at most MAX_REDIRECTS redirects, each within the publisher cover hosts. */
async function downloadCover(url: URL, hop: PublicHttpsHop, signal: AbortSignal): Promise<Buffer> {
  let current = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (
      current.protocol !== "https:" ||
      (current.port && current.port !== "443") ||
      !coverHosts.has(current.hostname)
    ) {
      throw new Error("Journal covers come only from known publisher hosts over HTTPS.");
    }
    const response = await hop({ url: current, maxBytes: MAX_COVER_INPUT_BYTES, signal });
    if (response.status >= 300 && response.status < 400 && response.location) {
      current = new URL(response.location, current);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`The cover host returned HTTP ${response.status}.`);
    }
    if (response.truncated) throw new Error("The cover was too large.");
    return response.body;
  }
  throw new Error("The cover request redirected too many times.");
}

type CacheMetadata = {
  readonly version: number;
  readonly resolvedAt: string;
  readonly sourceUrl: string;
};

type FailureState = { readonly retryAfter: number; readonly attempts: number };

async function readJson(path: string): Promise<Readonly<Record<string, unknown>> | null> {
  try {
    const value: unknown = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

async function readCachedCover(input: {
  readonly directory: string;
  readonly cacheRoot: string;
  readonly journalTitle: string;
  readonly now: Date;
}): Promise<(JournalCoverMaterial & { readonly fresh: boolean }) | null> {
  const metadata = await readJson(NodePath.join(input.directory, "metadata.json"));
  if (metadata?.version !== COVER_VERSION || typeof metadata.resolvedAt !== "string") return null;
  try {
    const absolutePath = NodePath.join(input.directory, "cover.jpg");
    const stat = await NodeFSP.stat(absolutePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_COVER_OUTPUT_BYTES) return null;
    return {
      absolutePath: await NodeFSP.realpath(absolutePath),
      cacheRoot: await NodeFSP.realpath(input.cacheRoot),
      journalTitle: input.journalTitle,
      fresh: input.now.getTime() - Date.parse(metadata.resolvedAt) <= SUCCESS_TTL_MS,
    };
  } catch {
    return null;
  }
}

async function writeAtomically(path: string, contents: string | Buffer): Promise<void> {
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  try {
    await NodeFSP.rename(temporary, path);
  } catch (error) {
    await NodeFSP.rm(temporary, { force: true });
    throw error;
  }
}

/** Creates the journal's cache folder, refusing one that is a link out of the cache root. */
async function ownCacheDirectory(directory: string, cacheRoot: string): Promise<void> {
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await NodeFSP.lstat(directory);
  const expected = NodePath.join(await NodeFSP.realpath(cacheRoot), NodePath.basename(directory));
  if (!stat.isDirectory() || (await NodeFSP.realpath(directory)) !== expected) {
    throw new Error("The journal cover cache folder is not inside the cache.");
  }
}

/** Downloads in flight at once; each may hold a full original cover in memory. */
const MAX_ACTIVE_DOWNLOADS = 3;
let activeDownloads = 0;
const downloadWaiters: Array<() => void> = [];

async function takeDownloadSlot(): Promise<void> {
  if (activeDownloads < MAX_ACTIVE_DOWNLOADS) {
    activeDownloads += 1;
    return;
  }
  // A finishing download hands its slot straight to the next waiter.
  const { promise, resolve } = Promise.withResolvers<void>();
  downloadWaiters.push(resolve);
  await promise;
}

function releaseDownloadSlot(): void {
  const next = downloadWaiters.shift();
  if (next) next();
  else activeDownloads -= 1;
}

async function discover(input: {
  readonly record: ScientSourceRecord;
  readonly cacheRoot: string;
  readonly directory: string;
  readonly journalTitle: string;
  readonly candidates: readonly URL[];
  readonly options: JournalCoverResolverOptions;
}): Promise<JournalCoverMaterial | null> {
  const hop = input.options.httpsHop ?? publicHttpsHop;
  const shrink = input.options.shrink ?? shrinkJournalCover;
  const controller = new AbortController();
  // Waiting for a turn holds no cover in memory; the deadline covers only the lookup itself.
  await takeDownloadSlot();
  const timer = NodeTimers.setTimeout(() => controller.abort(), COVER_DISCOVERY_TIMEOUT_MS);
  timer.unref();
  try {
    try {
      for (const candidate of input.candidates) {
        if (controller.signal.aborted) break;
        try {
          const original = await downloadCover(candidate, hop, controller.signal);
          const cover = await shrink(original, controller.signal);
          if (!cover) continue;
          await ownCacheDirectory(input.directory, input.cacheRoot);
          const coverPath = NodePath.join(input.directory, "cover.jpg");
          await writeAtomically(coverPath, cover);
          const material = {
            absolutePath: await NodeFSP.realpath(coverPath),
            cacheRoot: await NodeFSP.realpath(input.cacheRoot),
            journalTitle: input.journalTitle,
          };
          // Written last: once it is visible, the cover is complete.
          await writeAtomically(
            NodePath.join(input.directory, "metadata.json"),
            `${JSON.stringify({
              version: COVER_VERSION,
              resolvedAt: (input.options.now?.() ?? new Date()).toISOString(),
              sourceUrl: candidate.href,
            } satisfies CacheMetadata)}\n`,
          );
          await NodeFSP.rm(NodePath.join(input.directory, "failure.json"), { force: true });
          return material;
        } catch {
          // The next publisher address may still have the cover.
        }
      }
    } finally {
      releaseDownloadSlot();
    }
  } finally {
    controller.abort();
    NodeTimers.clearTimeout(timer);
  }
  const previous = await readJson(NodePath.join(input.directory, "failure.json"));
  const attempts = Math.min(
    16,
    (previous?.version === COVER_VERSION && typeof previous.attempts === "number"
      ? previous.attempts
      : 0) + 1,
  );
  const now = (input.options.now?.() ?? new Date()).getTime();
  await ownCacheDirectory(input.directory, input.cacheRoot);
  await writeAtomically(
    NodePath.join(input.directory, "failure.json"),
    JSON.stringify({
      version: COVER_VERSION,
      attempts,
      retryAfter: now + Math.min(MAX_FAILURE_TTL_MS, FAILURE_TTL_MS * 2 ** (attempts - 1)),
    }),
  );
  return null;
}

/**
 * The journal's current cover from its publisher, fetched once and kept for a month.
 * Journals whose publisher serves no cover at a known address have none.
 */
export async function resolveJournalCover(input: {
  readonly record: ScientSourceRecord;
  readonly cacheRoot: string;
  readonly options?: JournalCoverResolverOptions;
}): Promise<JournalCoverMaterial | null> {
  const journalTitle = input.record.containerTitle?.trim();
  const identity = journalIconIdentity(input.record);
  if (!journalTitle || !identity) return null;
  const candidates = journalCoverCandidates(input.record);
  if (candidates.length === 0) return null;
  const key = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([identity, candidates.map((url) => url.href)]))
    .digest("hex");
  const directory = NodePath.join(input.cacheRoot, key);
  const now = input.options?.now?.() ?? new Date();
  const cached = await readCachedCover({ ...input, directory, journalTitle, now });
  const material = cached
    ? {
        absolutePath: cached.absolutePath,
        cacheRoot: cached.cacheRoot,
        journalTitle: cached.journalTitle,
      }
    : null;
  if (cached?.fresh) return material;
  const failure = await readJson(NodePath.join(directory, "failure.json"));
  const retry: FailureState | null =
    failure?.version === COVER_VERSION &&
    typeof failure.retryAfter === "number" &&
    typeof failure.attempts === "number"
      ? { retryAfter: failure.retryAfter, attempts: failure.attempts }
      : null;
  if (retry && retry.retryAfter > now.getTime()) return material;
  const activeKey = `${NodePath.resolve(input.cacheRoot)}\0${key}`;
  const active = activeResolutions.get(activeKey);
  if (active) return material ?? active;
  const resolution = discover({
    record: input.record,
    cacheRoot: input.cacheRoot,
    directory,
    journalTitle,
    candidates,
    options: input.options ?? {},
  })
    .catch(() => null)
    .finally(() => activeResolutions.delete(activeKey));
  activeResolutions.set(activeKey, resolution);
  // A stale cover keeps showing while its replacement is fetched.
  return material ?? resolution;
}
