// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Release discovery is a bounded CI-only network boundary; app runtime policy stays in @scientfactory/provider-runtime.
import * as NodeCrypto from "node:crypto";

import {
  ANTIGRAVITY_ACP_TARGETS,
  MANAGED_RUNTIME_CATALOG_PROVIDERS as managedRuntimeProviders,
  MANAGED_RUNTIME_POLICY,
  DROID_LATEST_VERSION_URL,
  parseDroidReleaseVersion,
  antigravityAcpExecutableNames,
  isAntigravityAcpNativeVersion,
  resolveAntigravityAcpCatalogAsset,
  hydrateManagedRuntimeArtifact,
  compareManagedRuntimeReleases,
  isSameCursorReleaseDate,
  isValidManagedRuntimeSupersedes,
  MAX_CURSOR_SUPERSEDES,
  managedRuntimeTargetKey,
  resolveReviewedAntigravityArtifact,
  resolveReviewedClaudeArtifact,
  resolveReviewedCodexArtifact,
  resolveReviewedCursorArtifact,
  resolveReviewedDroidArtifact,
  resolveReviewedGrokArtifact,
  isSupportedOmpMajor,
  OMP_SUPPORTED_MAJOR,
  resolveReviewedOmpArtifact,
  resolveReviewedPiArtifact,
  resolveScientAgentArtifactPolicy,
  isSupportedScientAgentVersion,
  type ManagedRuntimeArtifactPolicy,
  type ManagedRuntimeProvider,
  type ManagedRuntimeCatalogProvider,
  type ManagedRuntimeTarget,
} from "@scientfactory/provider-runtime";
import bundledCatalogJson from "../../apps/server/src/scient/providerLifecycle/bundled-managed-runtime-catalog.json" with { type: "json" };
import { inspectAntigravityAcpArtifact } from "./antigravity-acp-artifact.ts";

export const ANTIGRAVITY_ACP_REGISTRY_URL =
  "https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json";

const MAX_METADATA_BYTES = 2 * 1_024 * 1_024;
const MAX_ARTIFACT_BYTES = 4 * 1_024 * 1_024 * 1_024;
const REQUEST_TIMEOUT_MS = 30_000;
const ARTIFACT_TIMEOUT_MS = 15 * 60_000;

export interface ManagedRuntimeCatalogArtifactData {
  readonly artifactName: string;
  readonly url: string;
  readonly checksum: {
    readonly algorithm: "sha256" | "sha512";
    readonly digest: string;
  };
  readonly size: number;
  readonly antigravityAcp?: {
    readonly version: string;
    readonly executableBytes: number;
    readonly harnessBytes: number;
  };
}

export interface ManagedRuntimeCatalogProviderData {
  readonly contractRevision: number;
  readonly channel: "stable";
  readonly version: string;
  readonly supersedes?: ReadonlyArray<string> | undefined;
  readonly artifacts: Readonly<Record<string, ManagedRuntimeCatalogArtifactData>>;
}

export interface ManagedRuntimeCatalogData {
  readonly schemaVersion: 1;
  readonly providers: Readonly<
    Partial<Record<ManagedRuntimeCatalogProvider, ManagedRuntimeCatalogProviderData>>
  >;
  /** Discovery predecessor, retained only in the immutable qualification artifact. */
  readonly cursorDiscoveryBase?: string | undefined;
}

export interface ManagedRuntimeCatalogRefreshResult {
  readonly catalog: ManagedRuntimeCatalogData;
  readonly changedProviders: ReadonlyArray<ManagedRuntimeCatalogProvider>;
  readonly failedProviders?: ReadonlyArray<ManagedRuntimeCatalogProvider>;
}

type Fetch = (input: URL, init?: RequestInit) => Promise<Response>;
type PolicyResolver = (target: ManagedRuntimeTarget) => ManagedRuntimeArtifactPolicy | undefined;

const targets: ReadonlyArray<ManagedRuntimeTarget> = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "arm64", libc: "glibc" },
  { platform: "linux", arch: "arm64", libc: "musl" },
  { platform: "linux", arch: "x64", libc: "glibc" },
  { platform: "linux", arch: "x64", libc: "musl" },
  { platform: "win32", arch: "arm64" },
  { platform: "win32", arch: "x64" },
];

const policyResolvers: Readonly<Record<ManagedRuntimeProvider, PolicyResolver>> = {
  codex: resolveReviewedCodexArtifact,
  claudeAgent: resolveReviewedClaudeArtifact,
  antigravity: resolveReviewedAntigravityArtifact,
  cursor: resolveReviewedCursorArtifact,
  droid: resolveReviewedDroidArtifact,
  grok: resolveReviewedGrokArtifact,
  pi: resolveReviewedPiArtifact,
  omp: resolveReviewedOmpArtifact,
  scient: resolveScientAgentArtifactPolicy,
};

export function isManagedRuntimeProvider(value: string): value is ManagedRuntimeCatalogProvider {
  return managedRuntimeProviders.some((provider) => provider === value);
}

function policyEntries(provider: ManagedRuntimeProvider) {
  const resolve = policyResolvers[provider];
  return targets.flatMap((target) => {
    const policy = resolve(target);
    return policy ? [{ key: managedRuntimeTargetKey(target), policy }] : [];
  });
}

function approvedTargetKeys(provider: ManagedRuntimeCatalogProvider): ReadonlyArray<string> {
  return provider === "antigravityAcp"
    ? ANTIGRAVITY_ACP_TARGETS.map((target) => `${target.platform}-${target.arch}`)
    : policyEntries(provider).map(({ key }) => key);
}

function hasCompleteApprovedTargetSet(
  provider: ManagedRuntimeCatalogProvider,
  release: ManagedRuntimeCatalogProviderData,
): boolean {
  const approved = approvedTargetKeys(provider);
  const candidate = Object.keys(release.artifacts);
  return (
    candidate.length === approved.length &&
    approved.every((key) => release.artifacts[key] !== undefined)
  );
}

function strictVersion(value: string, label: string): string {
  const version = value.trim();
  if (!/^[0-9]+(?:\.[0-9]+)+(?:-[0-9A-Za-z._]+)?$/u.test(version) || version.length > 128) {
    throw new Error(`${label} returned an invalid stable version '${version}'.`);
  }
  return version;
}

function strictDigest(value: string, algorithm: "sha256" | "sha512", label: string): string {
  const digest = value.trim().toLowerCase();
  const expected = algorithm === "sha256" ? 64 : 128;
  if (digest.length !== expected || !/^[0-9a-f]+$/u.test(digest)) {
    throw new Error(`${label} returned an invalid ${algorithm} digest.`);
  }
  return digest;
}

function strictSize(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_ARTIFACT_BYTES) {
    throw new Error(`${label} returned an invalid artifact size.`);
  }
  return value;
}

async function request(input: {
  readonly fetch: Fetch;
  readonly url: string;
  readonly method?: "GET" | "HEAD";
  readonly timeoutMs?: number;
  readonly allowNotFound?: boolean;
}): Promise<Response> {
  const url = new URL(input.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw new Error(`Release metadata URL is not standard HTTPS: ${input.url}`);
  }
  const response = await input.fetch(url, {
    method: input.method ?? "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(input.timeoutMs ?? REQUEST_TIMEOUT_MS),
    headers: { "user-agent": "Scient-managed-runtime-catalog/1" },
  });
  if (!response.ok && !(input.allowNotFound && response.status === 404)) {
    throw new Error(`Release request failed with HTTP ${response.status}: ${input.url}`);
  }
  return response;
}

async function metadataText(fetch_: Fetch, url: string): Promise<string> {
  const response = await request({ fetch: fetch_, url });
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_METADATA_BYTES) throw new Error(`Release metadata is too large: ${url}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_METADATA_BYTES) {
    throw new Error(`Release metadata is too large: ${url}`);
  }
  return text;
}

async function metadataJson(fetch_: Fetch, url: string): Promise<unknown> {
  return JSON.parse(await metadataText(fetch_, url));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${label} is missing '${key}'.`);
  }
  return field;
}

async function artifactSize(fetch_: Fetch, url: string): Promise<number> {
  const response = await request({ fetch: fetch_, url, method: "HEAD" });
  return strictSize(Number(response.headers.get("content-length")), url);
}

async function artifactDigest(
  fetch_: Fetch,
  url: string,
  algorithm: "sha256" | "sha512",
): Promise<{ readonly digest: string; readonly size: number }> {
  const response = await request({ fetch: fetch_, url, timeoutMs: ARTIFACT_TIMEOUT_MS });
  if (!response.body) throw new Error(`Release artifact has no response body: ${url}`);
  const hash = NodeCrypto.createHash(algorithm);
  const reader = response.body.getReader();
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    strictSize(size, url);
    hash.update(result.value);
  }
  return { digest: hash.digest("hex"), size: strictSize(size, url) };
}

async function mapConcurrent<T, R>(
  values: ReadonlyArray<T>,
  limit: number,
  f: (value: T) => Promise<R>,
): Promise<ReadonlyArray<R>> {
  const results: R[] = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      for (;;) {
        const current = index++;
        if (current >= values.length) return;
        results[current] = await f(values[current]!);
      }
    }),
  );
  return results;
}

function candidateProvider(input: {
  readonly provider: ManagedRuntimeCatalogProvider;
  readonly version: string;
  readonly artifacts: Readonly<Record<string, ManagedRuntimeCatalogArtifactData>>;
  readonly supersedes?: ReadonlyArray<string> | undefined;
}): ManagedRuntimeCatalogProviderData {
  if (!isValidManagedRuntimeSupersedes(input.provider, input.version, input.supersedes)) {
    throw new Error(`${input.provider} has invalid release ordering metadata.`);
  }
  if (input.provider === "antigravityAcp") {
    const release = {
      contractRevision: MANAGED_RUNTIME_POLICY[input.provider].revision,
      channel: "stable" as const,
      version: input.version,
      artifacts: input.artifacts,
    };
    if (
      Object.keys(input.artifacts).length !== ANTIGRAVITY_ACP_TARGETS.length ||
      ANTIGRAVITY_ACP_TARGETS.some(
        (target) =>
          !resolveAntigravityAcpCatalogAsset(
            { providers: { antigravityAcp: release } },
            target.platform,
            target.arch,
          ),
      )
    ) {
      throw new Error("Antigravity ACP release violates app-owned target or artifact policy.");
    }
    return release;
  }
  const policies = policyEntries(input.provider);
  if (Object.keys(input.artifacts).length !== policies.length) {
    throw new Error(`${input.provider} discovery did not return every app-approved target.`);
  }
  for (const { key, policy } of policies) {
    const artifact = input.artifacts[key];
    if (!artifact) throw new Error(`${input.provider} is missing ${key}.`);
    const hydrated = hydrateManagedRuntimeArtifact(policy, {
      provider: input.provider,
      version: input.version,
      target: policy.target,
      ...artifact,
      catalogRevision: `automation:${input.provider}:${input.version}:${key}`,
    });
    if (!hydrated) throw new Error(`${input.provider} ${key} violates app-owned runtime policy.`);
  }
  return {
    contractRevision: MANAGED_RUNTIME_POLICY[input.provider].revision,
    channel: "stable",
    version: input.version,
    ...(input.supersedes ? { supersedes: input.supersedes.toSorted() } : {}),
    artifacts: input.artifacts,
  };
}

/** Read siblings structurally; execution policy is applied only to the selected family. */
export function readManagedRuntimeCatalog(
  input: unknown,
  selected?: ManagedRuntimeCatalogProvider,
  report: (message: string) => void = () => undefined,
): ManagedRuntimeCatalogData {
  const root = record(input, "Managed runtime catalog");
  if (root.schemaVersion !== 1) throw new Error("Managed runtime catalog schema is unsupported.");
  const rawProviders = record(root.providers, "Managed runtime catalog providers");
  const entries = new Map<string, ManagedRuntimeCatalogProviderData>();
  for (const [provider, value] of Object.entries(rawProviders)) {
    try {
      const release = record(value, "Provider release");
      if (
        !Number.isSafeInteger(release.contractRevision) ||
        Number(release.contractRevision) < 1 ||
        release.channel !== "stable"
      ) {
        throw new Error("Invalid provider contract or channel.");
      }
      const version = stringField(release, "version", "Provider release");
      if (version.length > 128) throw new Error("Invalid provider version.");
      const rawArtifacts = record(release.artifacts, "Provider artifacts");
      for (const value of Object.values(rawArtifacts)) {
        const artifact = record(value, "Provider artifact");
        const checksum = record(artifact.checksum, "Provider checksum");
        const algorithm = checksum.algorithm;
        if (algorithm !== "sha256" && algorithm !== "sha512")
          throw new Error("Invalid checksum algorithm.");
        strictDigest(
          stringField(checksum, "digest", "Provider checksum"),
          algorithm,
          "Provider checksum",
        );
        if (
          stringField(artifact, "artifactName", "Provider artifact").length > 512 ||
          stringField(artifact, "url", "Provider artifact").length > 2048 ||
          typeof artifact.size !== "number"
        ) {
          throw new Error("Invalid artifact identity.");
        }
        strictSize(artifact.size, "Provider artifact");
        if (artifact.antigravityAcp !== undefined) {
          const payload = record(artifact.antigravityAcp, "ACP payload");
          if (
            stringField(payload, "version", "ACP payload").length > 128 ||
            typeof payload.executableBytes !== "number" ||
            typeof payload.harnessBytes !== "number"
          ) {
            throw new Error("Invalid ACP payload identity.");
          }
          strictSize(payload.executableBytes, "ACP executable");
          strictSize(payload.harnessBytes, "ACP harness");
        }
      }
      // Valid siblings are preserved verbatim, including newer contracts and unknown fields.
      entries.set(provider, value as ManagedRuntimeCatalogProviderData);
    } catch (cause) {
      if (provider === selected) throw cause;
      report(
        `Quarantined ${isManagedRuntimeProvider(provider) ? provider : "unknown provider"} malformed catalog entry.`,
      );
    }
  }
  const providers = Object.fromEntries(entries);
  const catalog: ManagedRuntimeCatalogData = {
    schemaVersion: 1,
    providers,
    ...(typeof root.cursorDiscoveryBase === "string" &&
    /^[0-9a-f]{64}$/u.test(root.cursorDiscoveryBase)
      ? { cursorDiscoveryBase: root.cursorDiscoveryBase }
      : {}),
  };
  if (selected && providers[selected]) {
    const validated = validateManagedRuntimeCatalog({
      schemaVersion: 1,
      providers: { [selected]: providers[selected] },
    });
    return { ...catalog, providers: { ...providers, [selected]: validated.providers[selected]! } };
  }
  return catalog;
}

/** Binds a Cursor qualification to its predecessor without depending on sibling changes. */
export function managedRuntimeProviderIdentity(
  release: ManagedRuntimeCatalogProviderData | undefined,
): string {
  const normalized = release
    ? {
        contractRevision: release.contractRevision,
        channel: release.channel,
        version: release.version,
        supersedes: release.supersedes?.toSorted() ?? [],
        artifacts: Object.entries(release.artifacts)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([key, artifact]) => [
            key,
            {
              artifactName: artifact.artifactName,
              url: artifact.url,
              checksum: {
                algorithm: artifact.checksum.algorithm,
                digest: artifact.checksum.digest,
              },
              size: artifact.size,
              antigravityAcp: artifact.antigravityAcp,
            },
          ]),
      }
    : null;
  return NodeCrypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function validateManagedRuntimeCatalog(input: unknown): ManagedRuntimeCatalogData {
  const root = record(input, "Managed runtime catalog");
  if (root.schemaVersion !== 1) {
    throw new Error("Managed runtime catalog schema is unsupported.");
  }
  const rawProviders = record(root.providers, "Managed runtime catalog providers");
  const unexpected = Object.keys(rawProviders).filter(
    (provider) => !isManagedRuntimeProvider(provider),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Managed runtime catalog contains unknown providers: ${unexpected.join(", ")}.`,
    );
  }

  const providers: Partial<
    Record<ManagedRuntimeCatalogProvider, ManagedRuntimeCatalogProviderData>
  > = {};
  for (const provider of managedRuntimeProviders) {
    // A feed can predate an app-approved family. Keep it absent until that
    // family's own discovery and native qualification succeed.
    if (rawProviders[provider] === undefined) continue;
    const rawRelease = record(rawProviders[provider], `Managed runtime catalog ${provider}`);
    const policyContract = MANAGED_RUNTIME_POLICY[provider];
    const contractRevision = rawRelease.contractRevision;
    if (
      typeof contractRevision !== "number" ||
      (contractRevision !== policyContract.revision &&
        !policyContract.historicalRevisions.includes(contractRevision))
    ) {
      throw new Error(`${provider} has an unsupported managed runtime contract revision.`);
    }
    if (rawRelease.channel !== "stable") {
      throw new Error(`${provider} is not pinned to its stable release channel.`);
    }
    const version = strictVersion(
      stringField(rawRelease, "version", `${provider} catalog release`),
      `${provider} catalog release`,
    );
    if (!isValidManagedRuntimeSupersedes(provider, version, rawRelease.supersedes)) {
      throw new Error(`${provider} has invalid release ordering metadata.`);
    }
    const supersedes = rawRelease.supersedes;
    const rawArtifacts = record(rawRelease.artifacts, `${provider} catalog artifacts`);
    const historical = contractRevision !== policyContract.revision;
    const entries = historical
      ? Object.keys(rawArtifacts).map((key) => ({ key }))
      : provider === "antigravityAcp"
        ? ANTIGRAVITY_ACP_TARGETS.map((target) => ({ key: `${target.platform}-${target.arch}` }))
        : policyEntries(provider);
    const expectedTargets = new Set(entries.map(({ key }) => key));
    const artifactKeys = Object.keys(rawArtifacts);
    const unexpectedTargets = artifactKeys.filter((key) => !expectedTargets.has(key));
    if (unexpectedTargets.length > 0) {
      throw new Error(`${provider} contains unapproved targets: ${unexpectedTargets.join(", ")}.`);
    }
    if (artifactKeys.length === 0) {
      throw new Error(`${provider} does not contain any app-approved targets.`);
    }
    // A generated feed can predate newly app-approved targets. Decode its approved
    // subset so that the provider's own discovery and native qualification can
    // add the missing targets without disabling its already qualified artifacts.
    if (!historical && provider === "antigravityAcp" && artifactKeys.length !== entries.length) {
      throw new Error("Antigravity ACP does not contain every app-approved target.");
    }

    const artifacts: Record<string, ManagedRuntimeCatalogArtifactData> = {};
    for (const { key } of entries.filter(({ key }) => rawArtifacts[key] !== undefined)) {
      const rawArtifact = record(rawArtifacts[key], `${provider} ${key} artifact`);
      const rawChecksum = record(rawArtifact.checksum, `${provider} ${key} checksum`);
      const algorithm = stringField(rawChecksum, "algorithm", `${provider} ${key} checksum`);
      if (algorithm !== "sha256" && algorithm !== "sha512") {
        throw new Error(`${provider} ${key} uses an unsupported checksum algorithm.`);
      }
      artifacts[key] = {
        artifactName: stringField(rawArtifact, "artifactName", `${provider} ${key} artifact`),
        url: stringField(rawArtifact, "url", `${provider} ${key} artifact`),
        checksum: {
          algorithm,
          digest: strictDigest(
            stringField(rawChecksum, "digest", `${provider} ${key} checksum`),
            algorithm,
            `${provider} ${key}`,
          ),
        },
        size: strictSize(Number(rawArtifact.size), `${provider} ${key}`),
        ...(provider === "antigravityAcp"
          ? (() => {
              const payload = record(rawArtifact.antigravityAcp, `${provider} ${key} payload`);
              return {
                antigravityAcp: {
                  version: stringField(payload, "version", `${provider} ${key} native version`),
                  executableBytes: strictSize(
                    Number(payload.executableBytes),
                    `${provider} ${key} executable`,
                  ),
                  harnessBytes: strictSize(
                    Number(payload.harnessBytes),
                    `${provider} ${key} harness`,
                  ),
                },
              };
            })()
          : {}),
      };
    }
    if (historical) {
      providers[provider] = {
        contractRevision,
        channel: "stable",
        version,
        artifacts,
        ...(supersedes ? { supersedes: supersedes.toSorted() } : {}),
      };
      continue;
    }
    if (provider === "antigravityAcp") {
      providers[provider] = candidateProvider({ provider, version, artifacts });
      continue;
    }
    for (const { key, policy } of policyEntries(provider)) {
      const artifact = artifacts[key];
      if (!artifact) continue;
      const hydrated = hydrateManagedRuntimeArtifact(policy, {
        provider,
        version,
        target: policy.target,
        ...artifact,
        catalogRevision: `validation:${provider}:${version}:${key}`,
      });
      if (!hydrated) throw new Error(`${provider} ${key} violates app-owned runtime policy.`);
    }
    providers[provider] = {
      contractRevision,
      channel: "stable",
      version,
      artifacts,
      ...(supersedes ? { supersedes: supersedes.toSorted() } : {}),
    };
  }

  return { schemaVersion: 1, providers };
}

function releaseChanged(
  provider: ManagedRuntimeCatalogProvider,
  current: ManagedRuntimeCatalogProviderData | undefined,
  version: string,
): boolean {
  if (!current) return true;
  if (current.version === version) {
    return (
      current.contractRevision !== MANAGED_RUNTIME_POLICY[provider].revision ||
      approvedTargetKeys(provider).some((key) => current.artifacts[key] === undefined)
    );
  }
  const comparison = compareManagedRuntimeReleases({ provider, current, candidate: { version } });
  if (
    comparison === "unknown" &&
    provider === "cursor" &&
    isSameCursorReleaseDate(current.version, version)
  )
    return true;
  if (comparison !== "newer") {
    throw new Error(
      `${provider} stable discovery moved backwards from ${current.version} to ${version}.`,
    );
  }
  return true;
}

/** Only the current, complete app-owned policy can enter native qualification or publication. */
export function validateManagedRuntimeCandidate(
  catalog: ManagedRuntimeCatalogData,
  provider: ManagedRuntimeCatalogProvider,
): ManagedRuntimeCatalogProviderData {
  const release = catalog.providers[provider];
  if (
    !release ||
    release.channel !== "stable" ||
    release.contractRevision !== MANAGED_RUNTIME_POLICY[provider].revision
  ) {
    throw new Error(`${provider} candidate does not use the current managed runtime contract.`);
  }
  if (!hasCompleteApprovedTargetSet(provider, release)) {
    throw new Error(`${provider} candidate does not contain every app-approved target.`);
  }
  return candidateProvider({
    provider,
    version: release.version,
    artifacts: release.artifacts,
    supersedes: release.supersedes,
  });
}

function preservesPublishedArtifacts(input: {
  readonly provider: ManagedRuntimeCatalogProvider;
  readonly current: ManagedRuntimeCatalogProviderData;
  readonly candidate: ManagedRuntimeCatalogProviderData;
}): boolean {
  const approved = new Set(approvedTargetKeys(input.provider));
  const currentEntries = Object.entries(input.current.artifacts);
  const candidateEntries = Object.entries(input.candidate.artifacts);
  return (
    hasCompleteApprovedTargetSet(input.provider, input.candidate) &&
    candidateEntries.length >= currentEntries.length &&
    currentEntries.every(
      ([key, artifact]) =>
        approved.has(key) &&
        JSON.stringify(input.candidate.artifacts[key]) === JSON.stringify(artifact),
    )
  );
}

export function parseCursorInstallerVersion(source: string): string {
  const versions = [
    ...source.matchAll(/downloads\.cursor\.com\/lab\/([^/"']+)\/\$\{OS\}\/\$\{ARCH\}/gu),
  ].map((match) => match[1]);
  const unique = [...new Set(versions)];
  if (unique.length !== 1 || !unique[0]) {
    throw new Error("Cursor installer did not expose one unambiguous stable CLI version.");
  }
  return strictVersion(unique[0], "Cursor installer");
}

export function parseDroidStableVersion(source: string): string {
  const version = parseDroidReleaseVersion(source);
  if (!version) throw new Error("Factory release feed did not expose a stable Droid CLI version.");
  return strictVersion(version, "Factory release feed");
}

export function parseGrokStableVersion(source: string): string {
  return strictVersion(source, "Grok stable channel");
}

async function discoverCodex(fetch_: Fetch): Promise<ManagedRuntimeCatalogProviderData> {
  const channel = record(
    await metadataJson(fetch_, "https://releases.openai.com/codex/channels/latest"),
    "Codex stable channel",
  );
  const version = strictVersion(
    stringField(channel, "tag_name", "Codex stable channel").replace(/^rust-v/u, ""),
    "Codex stable channel",
  );
  const assets = channel.assets;
  if (!Array.isArray(assets)) throw new Error("Codex stable channel is missing assets.");
  const byName = new Map(
    assets.map((value) => {
      const asset = record(value, "Codex release asset");
      return [stringField(asset, "name", "Codex release asset"), asset] as const;
    }),
  );
  const entries = await mapConcurrent(policyEntries("codex"), 4, async ({ key, policy }) => {
    const asset = byName.get(policy.artifactName);
    if (!asset) throw new Error(`Codex stable channel is missing ${policy.artifactName}.`);
    // The channel is the authoritative identity/digest source. Keep the app's
    // existing reviewed GitHub release host contract for the actual download.
    stringField(asset, "browser_download_url", `Codex ${key}`);
    const url = `https://github.com/openai/codex/releases/download/rust-v${version}/${policy.artifactName}`;
    const digest = strictDigest(
      stringField(asset, "digest", `Codex ${key}`).replace(/^sha256:/u, ""),
      "sha256",
      `Codex ${key}`,
    );
    return [
      key,
      {
        artifactName: policy.artifactName,
        url,
        checksum: { algorithm: "sha256" as const, digest },
        size: await artifactSize(fetch_, url),
      },
    ] as const;
  });
  return candidateProvider({ provider: "codex", version, artifacts: Object.fromEntries(entries) });
}

const claudePlatforms: Readonly<Record<string, string>> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64-glibc": "linux-arm64",
  "linux-arm64-musl": "linux-arm64-musl",
  "linux-x64-glibc": "linux-x64",
  "linux-x64-musl": "linux-x64-musl",
  "win32-arm64": "win32-arm64",
  "win32-x64": "win32-x64",
};

async function discoverClaude(fetch_: Fetch): Promise<ManagedRuntimeCatalogProviderData> {
  const version = strictVersion(
    await metadataText(fetch_, "https://downloads.claude.ai/claude-code-releases/latest"),
    "Claude stable channel",
  );
  const manifest = record(
    await metadataJson(
      fetch_,
      `https://downloads.claude.ai/claude-code-releases/${version}/manifest.json`,
    ),
    "Claude release manifest",
  );
  const platforms = record(manifest.platforms, "Claude release platforms");
  const entries = policyEntries("claudeAgent").map(({ key }) => {
    const platform = claudePlatforms[key];
    if (!platform) throw new Error(`Claude has no approved platform mapping for ${key}.`);
    const release = record(platforms[platform], `Claude ${key}`);
    const binary = stringField(release, "binary", `Claude ${key}`);
    const digest = strictDigest(
      stringField(release, "checksum", `Claude ${key}`),
      "sha256",
      `Claude ${key}`,
    );
    return [
      key,
      {
        artifactName: `claude-${version}-${platform}`,
        url: `https://downloads.claude.ai/claude-code-releases/${version}/${platform}/${binary}`,
        checksum: { algorithm: "sha256" as const, digest },
        size: strictSize(Number(release.size), `Claude ${key}`),
      },
    ] as const;
  });
  return candidateProvider({
    provider: "claudeAgent",
    version,
    artifacts: Object.fromEntries(entries),
  });
}

const antigravityPlatforms: Readonly<Record<string, string>> = {
  "darwin-arm64": "darwin_arm64",
  "darwin-x64": "darwin_amd64",
  "linux-arm64-glibc": "linux_arm64",
  "linux-x64-glibc": "linux_amd64",
  "win32-arm64": "windows_arm64",
  "win32-x64": "windows_amd64",
};

async function discoverAntigravity(fetch_: Fetch): Promise<ManagedRuntimeCatalogProviderData> {
  const entries = await mapConcurrent(policyEntries("antigravity"), 4, async ({ key }) => {
    const platform = antigravityPlatforms[key];
    if (!platform) throw new Error(`Antigravity has no approved platform mapping for ${key}.`);
    const manifest = record(
      await metadataJson(
        fetch_,
        `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${platform}.json`,
      ),
      `Antigravity ${key}`,
    );
    const version = strictVersion(
      stringField(manifest, "version", `Antigravity ${key}`),
      `Antigravity ${key}`,
    );
    const url = stringField(manifest, "url", `Antigravity ${key}`);
    return {
      key,
      version,
      artifact: {
        artifactName: new URL(url).pathname.split("/").at(-1)!,
        url,
        checksum: {
          algorithm: "sha512" as const,
          digest: strictDigest(
            stringField(manifest, "sha512", `Antigravity ${key}`),
            "sha512",
            `Antigravity ${key}`,
          ),
        },
        size: await artifactSize(fetch_, url),
      },
    };
  });
  const versions = [...new Set(entries.map((entry) => entry.version))];
  if (versions.length !== 1 || !versions[0]) {
    throw new Error("Antigravity platform manifests disagree on the stable version.");
  }
  return candidateProvider({
    provider: "antigravity",
    version: versions[0],
    artifacts: Object.fromEntries(entries.map((entry) => [entry.key, entry.artifact])),
  });
}

function cursorReleaseUrl(version: string, key: string): string {
  const [platform, arch] = key.split("-");
  const os = platform === "win32" ? "windows" : platform;
  const extension = platform === "win32" ? "zip" : "tar.gz";
  return `https://downloads.cursor.com/lab/${version}/${os}/${arch}/agent-cli-package.${extension}`;
}

async function discoverCursor(fetch_: Fetch): Promise<ManagedRuntimeCatalogProviderData> {
  const version = parseCursorInstallerVersion(
    await metadataText(fetch_, "https://cursor.com/install"),
  );
  const entries = await mapConcurrent(policyEntries("cursor"), 2, async ({ key, policy }) => {
    const url = cursorReleaseUrl(version, key);
    const release = await artifactDigest(fetch_, url, "sha256");
    return [
      key,
      {
        artifactName: policy.artifactName,
        url,
        checksum: { algorithm: "sha256" as const, digest: release.digest },
        size: release.size,
      },
    ] as const;
  });
  return candidateProvider({ provider: "cursor", version, artifacts: Object.fromEntries(entries) });
}

async function discoverDroid(fetch_: Fetch): Promise<ManagedRuntimeCatalogProviderData> {
  const version = parseDroidStableVersion(await metadataText(fetch_, DROID_LATEST_VERSION_URL));
  const entries = await mapConcurrent(policyEntries("droid"), 4, async ({ key, policy }) => {
    const bundled = resolveReviewedDroidArtifact(policy.target);
    if (!bundled) throw new Error(`Droid ${key} has no reviewed packaging baseline.`);
    const current = new URL(bundled.url);
    current.pathname = current.pathname.replace(
      /\/factory-cli\/releases\/[^/]+\//u,
      `/factory-cli/releases/${version}/`,
    );
    const url = current.href;
    const checksum = (await metadataText(fetch_, `${url}.sha256`)).split(/\s+/u)[0];
    return [
      key,
      {
        artifactName: policy.artifactName,
        url,
        checksum: {
          algorithm: "sha256" as const,
          digest: strictDigest(checksum ?? "", "sha256", `Droid ${key}`),
        },
        size: await artifactSize(fetch_, url),
      },
    ] as const;
  });
  return candidateProvider({ provider: "droid", version, artifacts: Object.fromEntries(entries) });
}

async function discoverGrok(fetch_: Fetch): Promise<ManagedRuntimeCatalogProviderData> {
  const version = parseGrokStableVersion(await metadataText(fetch_, "https://x.ai/cli/stable"));
  const entries = await mapConcurrent(policyEntries("grok"), 2, async ({ key, policy }) => {
    const bundled = resolveReviewedGrokArtifact(policy.target);
    if (!bundled) throw new Error(`Grok ${key} has no reviewed packaging baseline.`);
    const url = bundled.url.replace(bundled.version, version);
    const release = await artifactDigest(fetch_, url, "sha512");
    return [
      key,
      {
        artifactName: policy.artifactName.replace(bundled.version, version),
        url,
        checksum: { algorithm: "sha512" as const, digest: release.digest },
        size: release.size,
      },
    ] as const;
  });
  return candidateProvider({ provider: "grok", version, artifacts: Object.fromEntries(entries) });
}

async function discoverAntigravityAcp(fetch_: Fetch): Promise<ManagedRuntimeCatalogProviderData> {
  const registry = record(
    await metadataJson(fetch_, ANTIGRAVITY_ACP_REGISTRY_URL),
    "Antigravity ACP registry",
  );
  if (registry.id !== "antigravity-acp")
    throw new Error("The ACP registry entry changed identity.");
  const version = strictVersion(
    stringField(registry, "version", "Antigravity ACP registry"),
    "Antigravity ACP registry",
  );
  const distribution = record(
    record(registry.distribution, "Antigravity ACP distribution").binary,
    "Antigravity ACP binaries",
  );
  const entries = await mapConcurrent(ANTIGRAVITY_ACP_TARGETS, 2, async (target) => {
    const names = antigravityAcpExecutableNames(target.platform);
    const entry = record(distribution[target.registryKey], `Antigravity ACP ${target.registryKey}`);
    const url = stringField(entry, "archive", "Antigravity ACP archive");
    const prefix = `https://dl.google.com/agy-extensions/releases/${target.directory}/agy-acp-server-`;
    const suffix = `-${target.archiveSuffix}.zip`;
    if (!url.startsWith(prefix) || !url.endsWith(suffix) || entry.cmd !== `./${names.executable}`) {
      throw new Error(`Antigravity ACP ${target.registryKey} changed its approved packaging.`);
    }
    const nativeVersion = url.slice(prefix.length, -suffix.length);
    if (!isAntigravityAcpNativeVersion(nativeVersion))
      throw new Error("Antigravity ACP returned an invalid native release identity.");
    const inspected = await inspectAntigravityAcpArtifact(
      await request({ fetch: fetch_, url, timeoutMs: ARTIFACT_TIMEOUT_MS }),
      names.executable,
      names.harness,
    );
    return [
      `${target.platform}-${target.arch}`,
      {
        artifactName: url.slice(url.lastIndexOf("/") + 1),
        url,
        checksum: { algorithm: "sha256" as const, digest: inspected.digest },
        size: inspected.size,
        antigravityAcp: {
          version: nativeVersion,
          executableBytes: inspected.executableBytes,
          harnessBytes: inspected.harnessBytes,
        },
      },
    ] as const;
  });
  if (new Set(entries.map(([, artifact]) => artifact.antigravityAcp.version)).size !== 1)
    throw new Error("Antigravity ACP targets disagree on their native release.");
  return candidateProvider({
    provider: "antigravityAcp",
    version,
    artifacts: Object.fromEntries(entries),
  });
}

async function discoverPi(fetch_: Fetch): Promise<ManagedRuntimeCatalogProviderData> {
  const release = record(
    await metadataJson(fetch_, "https://api.github.com/repos/earendil-works/pi/releases/latest"),
    "Pi stable release",
  );
  if (release.prerelease !== false || release.draft !== false)
    throw new Error("Pi release is not stable.");
  const version = strictVersion(
    stringField(release, "tag_name", "Pi release").replace(/^v/u, ""),
    "Pi release",
  );
  if (!Array.isArray(release.assets)) throw new Error("Pi release assets are missing.");
  const assets = release.assets.map((value) => record(value, "Pi release asset"));
  const entries = await mapConcurrent(policyEntries("pi"), 4, async ({ key, policy }) => {
    const asset = assets.find((value) => value.name === policy.artifactName);
    if (!asset) throw new Error(`Pi release is missing ${policy.artifactName}.`);
    const url = `https://github.com/earendil-works/pi/releases/download/v${version}/${policy.artifactName}`;
    if (stringField(asset, "browser_download_url", "Pi release asset") !== url)
      throw new Error("Pi release asset URL differs from its policy.");
    const digest = strictDigest(
      stringField(asset, "digest", "Pi release asset").replace(/^sha256:/u, ""),
      "sha256",
      "Pi release asset",
    );
    return [
      key,
      {
        artifactName: policy.artifactName,
        url,
        checksum: { algorithm: "sha256" as const, digest },
        size: await artifactSize(fetch_, url),
      },
    ] as const;
  });
  return candidateProvider({ provider: "pi", version, artifacts: Object.fromEntries(entries) });
}

/**
 * A release outside the supported major is refused, not published: every
 * client refuses it, and because publication only accepts newer versions a
 * published next major would block every later patch of the supported one.
 */
function supportedOmpVersion(release: Record<string, unknown>): string {
  const version = strictVersion(
    stringField(release, "tag_name", "Oh My Pi release").replace(/^v/u, ""),
    "Oh My Pi release",
  );
  if (!isSupportedOmpMajor(version)) {
    throw new Error(
      `Oh My Pi ${version} is outside the supported major ${OMP_SUPPORTED_MAJOR}; qualify the new major before publishing it.`,
    );
  }
  return version;
}

async function discoverOmp(fetch_: Fetch): Promise<ManagedRuntimeCatalogProviderData> {
  const release = record(
    await metadataJson(fetch_, "https://api.github.com/repos/can1357/oh-my-pi/releases/latest"),
    "Oh My Pi stable release",
  );
  if (release.prerelease !== false || release.draft !== false) {
    throw new Error("Oh My Pi release is not stable.");
  }
  const version = supportedOmpVersion(release);
  if (!Array.isArray(release.assets)) throw new Error("Oh My Pi release assets are missing.");
  const assets = release.assets.map((value) => record(value, "Oh My Pi release asset"));
  const entries = await mapConcurrent(policyEntries("omp"), 2, async ({ key, policy }) => {
    const asset = assets.find((value) => value.name === policy.artifactName);
    if (!asset) throw new Error(`Oh My Pi release is missing ${policy.artifactName}.`);
    const url = `https://github.com/can1357/oh-my-pi/releases/download/v${version}/${policy.artifactName}`;
    if (stringField(asset, "browser_download_url", "Oh My Pi release asset") !== url) {
      throw new Error("Oh My Pi release asset URL differs from its policy.");
    }
    const digest = strictDigest(
      stringField(asset, "digest", "Oh My Pi release asset").replace(/^sha256:/u, ""),
      "sha256",
      "Oh My Pi release asset",
    );
    return [
      key,
      {
        artifactName: policy.artifactName,
        url,
        checksum: { algorithm: "sha256" as const, digest },
        size: await artifactSize(fetch_, url),
      },
    ] as const;
  });
  return candidateProvider({ provider: "omp", version, artifacts: Object.fromEntries(entries) });
}

const SCIENT_AGENT_RELEASE_API =
  "https://api.github.com/repos/ScientFactory/scient-agent/releases/latest";

async function scientAgentRelease(fetch_: Fetch): Promise<Record<string, unknown> | undefined> {
  const response = await request({
    fetch: fetch_,
    url: SCIENT_AGENT_RELEASE_API,
    allowNotFound: true,
  });
  if (response.status === 404) return undefined;
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_METADATA_BYTES) throw new Error("Scient Agent release metadata is too large.");
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_METADATA_BYTES)
    throw new Error("Scient Agent release metadata is too large.");
  const release = record(JSON.parse(body), "Scient Agent stable release");
  if (release.prerelease !== false || release.draft !== false) {
    throw new Error("Scient Agent release is not stable.");
  }
  const tag = stringField(release, "tag_name", "Scient Agent release");
  if (!tag.startsWith("v") || !isSupportedScientAgentVersion(tag.slice(1))) {
    throw new Error(`Scient Agent release tag '${tag}' is not a supported stable version.`);
  }
  return release;
}

async function discoverScientAgent(fetch_: Fetch): Promise<ManagedRuntimeCatalogProviderData> {
  const release = await scientAgentRelease(fetch_);
  if (!release) throw new Error("Scient Agent stable release disappeared during discovery.");
  const version = stringField(release, "tag_name", "Scient Agent release").slice(1);
  if (!Array.isArray(release.assets)) throw new Error("Scient Agent release assets are missing.");
  const assets = release.assets.map((value) => record(value, "Scient Agent release asset"));
  const entries = await mapConcurrent(policyEntries("scient"), 2, async ({ key, policy }) => {
    const url = `${policy.releaseUrlPrefix}${version}/${policy.artifactName}`;
    const asset = assets.find((value) => value.name === policy.artifactName);
    const checksumName = `${policy.artifactName}.sha256`;
    const checksumAsset = assets.find((value) => value.name === checksumName);
    if (!asset || !checksumAsset)
      throw new Error(`Scient Agent release is missing ${policy.artifactName} or its checksum.`);
    if (
      stringField(asset, "browser_download_url", "Scient Agent release asset") !== url ||
      stringField(checksumAsset, "browser_download_url", "Scient Agent checksum asset") !==
        `${url}.sha256`
    ) {
      throw new Error("Scient Agent release asset URL differs from its policy.");
    }
    const checksum = (await metadataText(fetch_, `${url}.sha256`)).trim();
    const match = /^([0-9a-fA-F]{64})[ \t]+\*?([^\r\n]+)$/u.exec(checksum);
    if (!match || match[2] !== policy.artifactName)
      throw new Error("Scient Agent checksum does not identify its release artifact.");
    const digest = strictDigest(match[1]!, "sha256", "Scient Agent release checksum");
    if (
      asset.digest !== undefined &&
      asset.digest !== null &&
      (typeof asset.digest !== "string" || asset.digest !== `sha256:${digest}`)
    ) {
      throw new Error("Scient Agent release checksum differs from GitHub's asset digest.");
    }
    const size = await artifactSize(fetch_, url);
    if (asset.size !== size)
      throw new Error("Scient Agent release size differs from GitHub's asset metadata.");
    return [
      key,
      {
        artifactName: policy.artifactName,
        url,
        checksum: { algorithm: "sha256" as const, digest },
        size,
      },
    ] as const;
  });
  return candidateProvider({ provider: "scient", version, artifacts: Object.fromEntries(entries) });
}

const discoverers: Readonly<
  Record<
    ManagedRuntimeCatalogProvider,
    (fetch_: Fetch) => Promise<ManagedRuntimeCatalogProviderData>
  >
> = {
  codex: discoverCodex,
  claudeAgent: discoverClaude,
  antigravity: discoverAntigravity,
  antigravityAcp: discoverAntigravityAcp,
  cursor: discoverCursor,
  droid: discoverDroid,
  grok: discoverGrok,
  pi: discoverPi,
  omp: discoverOmp,
  scient: discoverScientAgent,
};

export async function refreshManagedRuntimeCatalog(
  current: ManagedRuntimeCatalogData,
  fetch_: Fetch = fetch,
  report: (message: string) => void = () => undefined,
): Promise<ManagedRuntimeCatalogRefreshResult> {
  if (current.schemaVersion !== 1)
    throw new Error("Managed runtime catalog schema is unsupported.");
  let catalog = current;
  const changedProviders: ManagedRuntimeCatalogProvider[] = [];
  const failedProviders: ManagedRuntimeCatalogProvider[] = [];
  for (const provider of managedRuntimeProviders) {
    try {
      const result = await refreshManagedRuntimeProvider(catalog, provider, fetch_, report);
      catalog = result.catalog;
      changedProviders.push(...result.changedProviders);
    } catch (cause) {
      failedProviders.push(provider);
      report(
        `${provider} discovery failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
      );
    }
  }
  return { catalog, changedProviders, failedProviders };
}

function existingOrBundledRelease(
  catalog: ManagedRuntimeCatalogData,
  provider: ManagedRuntimeCatalogProvider,
): ManagedRuntimeCatalogProviderData | undefined {
  const bundledProviders: Readonly<Partial<Record<ManagedRuntimeCatalogProvider, unknown>>> =
    bundledCatalogJson.providers;
  const raw = catalog.providers[provider] ?? bundledProviders[provider];
  return raw
    ? validateManagedRuntimeCatalog({ schemaVersion: 1, providers: { [provider]: raw } }).providers[
        provider
      ]
    : undefined;
}

/** Discover one provider independently so a broken channel cannot block the other providers. */
export async function refreshManagedRuntimeProvider(
  current: ManagedRuntimeCatalogData,
  provider: ManagedRuntimeCatalogProvider,
  fetch_: Fetch = fetch,
  report: (message: string) => void = () => undefined,
): Promise<ManagedRuntimeCatalogRefreshResult> {
  if (current.schemaVersion !== 1) {
    throw new Error("Managed runtime catalog schema is unsupported.");
  }
  const existing = existingOrBundledRelease(current, provider);
  report(`Checking ${provider} stable channel.`);
  const latestVersion = await discoverLatestVersion(provider, fetch_);
  if (latestVersion === undefined) {
    report(
      existing
        ? `${provider} has no published stable release pointer; keeping qualified ${existing.version}.`
        : `${provider} has no published stable release; leaving its catalog entry absent.`,
    );
    return { catalog: current, changedProviders: [] };
  }
  const changed = releaseChanged(provider, existing, latestVersion);
  if (current.providers[provider] && !changed) {
    report(`${provider} is already current at ${latestVersion}.`);
    return { catalog: current, changedProviders: [] };
  }
  report(
    `Collecting ${provider} ${latestVersion} release metadata for contract ${MANAGED_RUNTIME_POLICY[provider].revision}.`,
  );
  const discovered = await discoverers[provider](fetch_);
  let candidate =
    provider === "cursor" && existing?.version === discovered.version && existing.supersedes
      ? { ...discovered, supersedes: existing.supersedes }
      : discovered;
  if (
    provider === "cursor" &&
    existing &&
    existing.version !== discovered.version &&
    isSameCursorReleaseDate(existing.version, discovered.version)
  ) {
    const supersedes = [existing.version, ...(existing.supersedes ?? [])].toSorted();
    if (supersedes.includes(discovered.version) || supersedes.length > MAX_CURSOR_SUPERSEDES) {
      throw new Error("Cursor replacement lineage is stale or exceeds its bound.");
    }
    candidate = { ...discovered, supersedes };
  }
  if (candidate.version !== latestVersion) {
    throw new Error(`${provider} stable release changed during discovery.`);
  }
  report(`${provider} ${latestVersion} candidate metadata is complete.`);
  return {
    catalog: {
      schemaVersion: 1,
      providers: { ...current.providers, [provider]: candidate },
      ...(provider === "cursor"
        ? { cursorDiscoveryBase: managedRuntimeProviderIdentity(existing) }
        : {}),
    },
    changedProviders: [provider],
  };
}

/**
 * Apply only one already-qualified provider to the latest generated catalog.
 * This is what lets independently qualified providers publish serially
 * without overwriting one another with an older candidate snapshot.
 */
export function mergeQualifiedManagedRuntimeProvider(input: {
  readonly current: ManagedRuntimeCatalogData;
  readonly candidate: ManagedRuntimeCatalogData;
  readonly provider: ManagedRuntimeCatalogProvider;
}): ManagedRuntimeCatalogData {
  const currentRelease = existingOrBundledRelease(input.current, input.provider);
  const candidateRelease = validateManagedRuntimeCandidate(input.candidate, input.provider);
  const policyContract = MANAGED_RUNTIME_POLICY[input.provider];
  if (!currentRelease) {
    return {
      schemaVersion: 1,
      providers: { ...input.current.providers, [input.provider]: candidateRelease },
    };
  }
  if (
    (currentRelease.contractRevision !== policyContract.revision &&
      !policyContract.historicalRevisions.includes(currentRelease.contractRevision)) ||
    candidateRelease.contractRevision < currentRelease.contractRevision
  ) {
    throw new Error(
      `${input.provider} attempted an unsupported managed runtime contract transition.`,
    );
  }
  if (currentRelease.version === candidateRelease.version) {
    if (
      managedRuntimeProviderIdentity(currentRelease) !==
      managedRuntimeProviderIdentity(candidateRelease)
    ) {
      if (
        JSON.stringify(currentRelease.supersedes) !== JSON.stringify(candidateRelease.supersedes) ||
        !preservesPublishedArtifacts({
          provider: input.provider,
          current: currentRelease,
          candidate: candidateRelease,
        }) ||
        (candidateRelease.contractRevision === currentRelease.contractRevision &&
          Object.keys(candidateRelease.artifacts).length <=
            Object.keys(currentRelease.artifacts).length)
      ) {
        throw new Error(`${input.provider} attempted a same-version catalog repack.`);
      }
      return {
        schemaVersion: 1,
        providers: { ...input.current.providers, [input.provider]: candidateRelease },
      };
    }
    return input.current.providers[input.provider]
      ? input.current
      : {
          schemaVersion: 1,
          providers: { ...input.current.providers, [input.provider]: candidateRelease },
        };
  }
  if (
    input.provider === "cursor" &&
    isSameCursorReleaseDate(currentRelease.version, candidateRelease.version)
  ) {
    if (
      input.candidate.cursorDiscoveryBase !== managedRuntimeProviderIdentity(currentRelease) ||
      JSON.stringify(candidateRelease.supersedes) !==
        JSON.stringify([currentRelease.version, ...(currentRelease.supersedes ?? [])].toSorted()) ||
      currentRelease.supersedes?.includes(candidateRelease.version)
    ) {
      throw new Error(
        "Cursor qualification predecessor changed or its replacement lineage is invalid; rediscover Cursor.",
      );
    }
  }
  if (
    compareManagedRuntimeReleases({
      provider: input.provider,
      current: currentRelease,
      candidate: candidateRelease,
    }) !== "newer"
  ) {
    throw new Error(
      `${input.provider} candidate ${candidateRelease.version} is not newer than ${currentRelease.version}.`,
    );
  }
  return {
    schemaVersion: 1,
    providers: { ...input.current.providers, [input.provider]: candidateRelease },
  };
}

async function discoverLatestVersion(
  provider: ManagedRuntimeCatalogProvider,
  fetch_: Fetch,
): Promise<string | undefined> {
  switch (provider) {
    case "antigravityAcp":
      return strictVersion(
        stringField(
          record(
            await metadataJson(fetch_, ANTIGRAVITY_ACP_REGISTRY_URL),
            "Antigravity ACP registry",
          ),
          "version",
          "Antigravity ACP registry",
        ),
        "Antigravity ACP registry",
      );
    case "codex": {
      const channel = record(
        await metadataJson(fetch_, "https://releases.openai.com/codex/channels/latest"),
        "Codex stable channel",
      );
      return strictVersion(
        stringField(channel, "tag_name", "Codex stable channel").replace(/^rust-v/u, ""),
        "Codex stable channel",
      );
    }
    case "claudeAgent":
      return strictVersion(
        await metadataText(fetch_, "https://downloads.claude.ai/claude-code-releases/latest"),
        "Claude stable channel",
      );
    case "antigravity": {
      const manifest = record(
        await metadataJson(
          fetch_,
          "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json",
        ),
        "Antigravity stable channel",
      );
      return strictVersion(
        stringField(manifest, "version", "Antigravity stable channel"),
        "Antigravity stable channel",
      );
    }
    case "cursor":
      return parseCursorInstallerVersion(await metadataText(fetch_, "https://cursor.com/install"));
    case "droid":
      return parseDroidStableVersion(await metadataText(fetch_, DROID_LATEST_VERSION_URL));
    case "grok":
      return parseGrokStableVersion(await metadataText(fetch_, "https://x.ai/cli/stable"));
    case "pi": {
      const release = record(
        await metadataJson(
          fetch_,
          "https://api.github.com/repos/earendil-works/pi/releases/latest",
        ),
        "Pi stable release",
      );
      return strictVersion(
        stringField(release, "tag_name", "Pi release").replace(/^v/u, ""),
        "Pi release",
      );
    }
    case "scient": {
      const release = await scientAgentRelease(fetch_);
      return release
        ? stringField(release, "tag_name", "Scient Agent release").slice(1)
        : undefined;
    }
    case "omp": {
      const release = record(
        await metadataJson(fetch_, "https://api.github.com/repos/can1357/oh-my-pi/releases/latest"),
        "Oh My Pi stable release",
      );
      return supportedOmpVersion(release);
    }
  }
}

/** The stable pointer must still name a same-day Cursor candidate at publication. */
export async function verifyManagedRuntimePromotionPointer(
  input: {
    readonly current: ManagedRuntimeCatalogData;
    readonly candidate: ManagedRuntimeCatalogData;
    readonly provider: ManagedRuntimeCatalogProvider;
  },
  fetch_: Fetch = fetch,
): Promise<void> {
  if (input.provider !== "cursor") return;
  const current = existingOrBundledRelease(input.current, "cursor");
  const candidate = validateManagedRuntimeCandidate(input.candidate, "cursor");
  if (
    !current ||
    current.version === candidate.version ||
    !isSameCursorReleaseDate(current.version, candidate.version)
  )
    return;
  if ((await discoverLatestVersion("cursor", fetch_)) !== candidate.version) {
    throw new Error("Cursor stable pointer changed after qualification; rediscover Cursor.");
  }
}
