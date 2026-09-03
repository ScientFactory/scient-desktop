// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Release discovery is a bounded CI-only network boundary; app runtime policy stays in @scientfactory/provider-runtime.
import * as NodeCrypto from "node:crypto";

import {
  ANTIGRAVITY_ACP_TARGETS,
  antigravityAcpExecutableNames,
  resolveAntigravityAcpCatalogAsset,
  hydrateManagedRuntimeArtifact,
  isManagedRuntimeUpdate,
  managedRuntimeTargetKey,
  resolveReviewedAntigravityArtifact,
  resolveReviewedClaudeArtifact,
  resolveReviewedCodexArtifact,
  resolveReviewedCursorArtifact,
  resolveReviewedDroidArtifact,
  resolveReviewedGrokArtifact,
  type ManagedRuntimeArtifact,
  type ManagedRuntimeProvider,
  type ManagedRuntimeCatalogProvider,
  type ManagedRuntimeTarget,
} from "@scientfactory/provider-runtime";
import bundledCatalogJson from "../../apps/server/src/scient/providerLifecycle/managed-runtime-catalog.json" with { type: "json" };
import { inspectAntigravityAcpArtifact } from "./antigravity-acp-artifact.ts";

export const ANTIGRAVITY_ACP_REGISTRY_URL =
  "https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json";

const MAX_METADATA_BYTES = 2 * 1_024 * 1_024;
const MAX_ARTIFACT_BYTES = 4 * 1_024 * 1_024 * 1_024;
const REQUEST_TIMEOUT_MS = 30_000;
const ARTIFACT_TIMEOUT_MS = 15 * 60_000;
const CONTRACT_REVISION = 1;

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
  readonly artifacts: Readonly<Record<string, ManagedRuntimeCatalogArtifactData>>;
}

export interface ManagedRuntimeCatalogData {
  readonly schemaVersion: 1;
  readonly providers: Readonly<
    Partial<Record<ManagedRuntimeCatalogProvider, ManagedRuntimeCatalogProviderData>>
  >;
}

export interface ManagedRuntimeCatalogRefreshResult {
  readonly catalog: ManagedRuntimeCatalogData;
  readonly changedProviders: ReadonlyArray<ManagedRuntimeCatalogProvider>;
}

type Fetch = (input: URL, init?: RequestInit) => Promise<Response>;
type PolicyResolver = (target: ManagedRuntimeTarget) => ManagedRuntimeArtifact | undefined;

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
};

export const managedRuntimeProviders: ReadonlyArray<ManagedRuntimeCatalogProvider> = [
  "codex",
  "claudeAgent",
  "antigravity",
  "antigravityAcp",
  "cursor",
  "droid",
  "grok",
];

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
  if (!response.ok) {
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
}): ManagedRuntimeCatalogProviderData {
  if (input.provider === "antigravityAcp") {
    const release = {
      contractRevision: CONTRACT_REVISION,
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
    contractRevision: CONTRACT_REVISION,
    channel: "stable",
    version: input.version,
    artifacts: input.artifacts,
  };
}

/**
 * Decode and re-apply the app-owned provider policy to an untrusted catalog.
 * Automation reads the generated branch through Git, so it must not trust a
 * TypeScript cast to establish that every provider and approved target is
 * complete or still obeys the runtime policy shipped on `main`.
 */
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
    // An older published feed remains valid while the new family is first qualified.
    if (provider === "antigravityAcp" && rawProviders[provider] === undefined) continue;
    const rawRelease = record(rawProviders[provider], `Managed runtime catalog ${provider}`);
    if (rawRelease.contractRevision !== CONTRACT_REVISION) {
      throw new Error(`${provider} has an unsupported managed runtime contract revision.`);
    }
    if (rawRelease.channel !== "stable") {
      throw new Error(`${provider} is not pinned to its stable release channel.`);
    }
    const version = strictVersion(
      stringField(rawRelease, "version", `${provider} catalog release`),
      `${provider} catalog release`,
    );
    const rawArtifacts = record(rawRelease.artifacts, `${provider} catalog artifacts`);
    const entries =
      provider === "antigravityAcp"
        ? ANTIGRAVITY_ACP_TARGETS.map((target) => ({ key: `${target.platform}-${target.arch}` }))
        : policyEntries(provider);
    const expectedTargets = new Set(entries.map(({ key }) => key));
    const unexpectedTargets = Object.keys(rawArtifacts).filter((key) => !expectedTargets.has(key));
    if (unexpectedTargets.length > 0) {
      throw new Error(`${provider} contains unapproved targets: ${unexpectedTargets.join(", ")}.`);
    }

    const artifacts: Record<string, ManagedRuntimeCatalogArtifactData> = {};
    for (const { key } of entries) {
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
    providers[provider] = candidateProvider({ provider, version, artifacts });
  }

  return { schemaVersion: 1, providers };
}

function releaseChanged(
  provider: ManagedRuntimeCatalogProvider,
  current: ManagedRuntimeCatalogProviderData,
  version: string,
): boolean {
  if (current.version === version) return false;
  if (!isManagedRuntimeUpdate({ provider, current: current.version, candidate: version })) {
    throw new Error(
      `${provider} stable discovery moved backwards from ${current.version} to ${version}.`,
    );
  }
  return true;
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

export function parseDroidRssVersion(source: string): string {
  const match = /<title><!\[CDATA\[[^\]]*\bCLI v([0-9]+(?:\.[0-9]+)+(?:-[0-9A-Za-z._]+)?)/u.exec(
    source,
  );
  if (!match?.[1])
    throw new Error("Factory release feed did not expose a stable Droid CLI version.");
  return strictVersion(match[1], "Factory release feed");
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
  const version = parseDroidRssVersion(
    await metadataText(fetch_, "https://docs.factory.ai/changelog/rss.xml"),
  );
  const entries = await mapConcurrent(policyEntries("droid"), 4, async ({ key, policy }) => {
    const current = new URL(policy.url);
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
    const url = policy.url.replace(policy.version, version);
    const release = await artifactDigest(fetch_, url, "sha512");
    return [
      key,
      {
        artifactName: policy.artifactName.replace(policy.version, version),
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
    if (!/^agy_acp_server_[A-Za-z0-9_.-]{1,96}$/u.test(nativeVersion))
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
  for (const provider of managedRuntimeProviders) {
    const result = await refreshManagedRuntimeProvider(catalog, provider, fetch_, report);
    catalog = result.catalog;
    changedProviders.push(...result.changedProviders);
  }
  return { catalog, changedProviders };
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
  const existing =
    current.providers[provider] ??
    (provider === "antigravityAcp"
      ? validateManagedRuntimeCatalog(bundledCatalogJson).providers.antigravityAcp
      : undefined);
  if (!existing) throw new Error(`Managed runtime catalog is missing ${provider}.`);
  report(`Checking ${provider} stable channel.`);
  const latestVersion = await discoverLatestVersion(provider, fetch_);
  if (!releaseChanged(provider, existing, latestVersion)) {
    report(`${provider} is already current at ${latestVersion}.`);
    return { catalog: current, changedProviders: [] };
  }
  report(`Collecting ${provider} ${latestVersion} release metadata.`);
  const candidate = await discoverers[provider](fetch_);
  if (candidate.version !== latestVersion) {
    throw new Error(`${provider} stable release changed during discovery.`);
  }
  report(`${provider} ${latestVersion} candidate metadata is complete.`);
  return {
    catalog: {
      schemaVersion: 1,
      providers: { ...current.providers, [provider]: candidate },
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
  const currentRelease =
    input.current.providers[input.provider] ??
    (input.provider === "antigravityAcp" ? bundledCatalogJson.providers.antigravityAcp : undefined);
  const candidateRelease = input.candidate.providers[input.provider];
  if (!currentRelease || !candidateRelease) {
    throw new Error(`Managed runtime catalog is missing ${input.provider}.`);
  }
  if (currentRelease.version === candidateRelease.version) {
    if (JSON.stringify(currentRelease) !== JSON.stringify(candidateRelease)) {
      throw new Error(`${input.provider} attempted a same-version catalog repack.`);
    }
    return input.current;
  }
  if (
    !isManagedRuntimeUpdate({
      provider: input.provider,
      current: currentRelease.version,
      candidate: candidateRelease.version,
    })
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
): Promise<string> {
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
      return parseDroidRssVersion(
        await metadataText(fetch_, "https://docs.factory.ai/changelog/rss.xml"),
      );
    case "grok":
      return parseGrokStableVersion(await metadataText(fetch_, "https://x.ai/cli/stable"));
  }
}
