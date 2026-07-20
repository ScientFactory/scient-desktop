import type { ProviderKind } from "@synara/contracts";

import type {
  ProviderRuntimeArtifact,
  ProviderRuntimeRecipe,
  ProviderRuntimeTarget,
} from "./providerRuntimeTypes";

const GITHUB_API_HOST = "api.github.com";
const GITHUB_DOWNLOAD_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
] as const;

export class ProviderRuntimeRecipeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderRuntimeRecipeError";
  }
}

function assertRecord(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderRuntimeRecipeError(`Invalid ${description} response.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, description: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProviderRuntimeRecipeError(`Invalid ${description}: missing ${key}.`);
  }
  return value.trim();
}

function optionalPositiveInt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function fetchText(input: {
  readonly url: string;
  readonly signal: AbortSignal;
  readonly allowedHosts: ReadonlyArray<string>;
  readonly headers?: Readonly<Record<string, string>>;
}): Promise<string> {
  const url = new URL(input.url);
  if (url.protocol !== "https:" || !input.allowedHosts.includes(url.hostname)) {
    throw new ProviderRuntimeRecipeError(`Runtime metadata host is not allowed: ${url.hostname}`);
  }
  const response = await fetch(url, {
    signal: input.signal,
    redirect: "error",
    headers: input.headers,
  });
  if (!response.ok) {
    throw new ProviderRuntimeRecipeError(
      `Runtime metadata request failed with HTTP ${response.status}.`,
    );
  }
  return response.text();
}

async function fetchJson(input: {
  readonly url: string;
  readonly signal: AbortSignal;
  readonly allowedHosts: ReadonlyArray<string>;
  readonly headers?: Readonly<Record<string, string>>;
}): Promise<unknown> {
  const text = await fetchText(input);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ProviderRuntimeRecipeError("Runtime metadata response is not valid JSON.", { cause });
  }
}

interface GithubReleaseAsset {
  readonly name: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

async function resolveGithubAsset(input: {
  readonly repo: string;
  readonly releaseTag: string;
  readonly expectedVersion: string;
  readonly assetName: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly version: string; readonly asset: GithubReleaseAsset }> {
  const release = assertRecord(
    await fetchJson({
      url: `https://${GITHUB_API_HOST}/repos/${input.repo}/releases/tags/${encodeURIComponent(input.releaseTag)}`,
      signal: input.signal,
      allowedHosts: [GITHUB_API_HOST],
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Scient-provider-runtime-manager",
      },
    }),
    "GitHub release",
  );
  const version = requiredString(release, "tag_name", "GitHub release").replace(
    /^(?:rust-)?v/u,
    "",
  );
  if (version !== input.expectedVersion) {
    throw new ProviderRuntimeRecipeError("Reviewed GitHub release version does not match.");
  }
  const assets = release.assets;
  if (!Array.isArray(assets)) {
    throw new ProviderRuntimeRecipeError("GitHub release does not contain an asset list.");
  }
  for (const value of assets) {
    const asset = assertRecord(value, "GitHub release asset");
    if (asset.name !== input.assetName) continue;
    const digest = requiredString(asset, "digest", "GitHub release asset");
    if (!digest.startsWith("sha256:")) {
      throw new ProviderRuntimeRecipeError("GitHub release asset does not have a SHA-256 digest.");
    }
    const size = optionalPositiveInt(asset, "size");
    if (!size) throw new ProviderRuntimeRecipeError("GitHub release asset has an invalid size.");
    return {
      version,
      asset: {
        name: input.assetName,
        url: requiredString(asset, "browser_download_url", "GitHub release asset"),
        size,
        sha256: digest.slice("sha256:".length),
      },
    };
  }
  throw new ProviderRuntimeRecipeError(`The latest release does not provide ${input.assetName}.`);
}

function githubArtifact(input: {
  readonly provider: ProviderKind;
  readonly target: ProviderRuntimeTarget;
  readonly version: string;
  readonly asset: GithubReleaseAsset;
  readonly executablePath: string;
  readonly smokeArgs?: ReadonlyArray<string>;
}): ProviderRuntimeArtifact {
  return {
    provider: input.provider,
    version: input.version,
    target: input.target,
    url: input.asset.url,
    allowedHosts: GITHUB_DOWNLOAD_HOSTS,
    digestAlgorithm: "sha256",
    digest: input.asset.sha256,
    size: input.asset.size,
    archiveFormat: input.asset.name.endsWith(".zip") ? "zip" : "tar.gz",
    executablePath: input.executablePath,
    smokeArgs: input.smokeArgs ?? ["--version"],
    catalogRevision: `github:${input.version}:${input.asset.sha256}`,
  };
}

function codexAsset(target: ProviderRuntimeTarget): {
  readonly name: string;
  readonly executablePath: string;
} {
  const targetTriple =
    target.platform === "darwin"
      ? `${target.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
      : target.platform === "linux"
        ? `${target.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl`
        : `${target.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`;
  const executablePath = `codex-${targetTriple}${target.platform === "win32" ? ".exe" : ""}`;
  return {
    name: `${executablePath}.${target.platform === "win32" ? "zip" : "tar.gz"}`,
    executablePath,
  };
}

function openCodeCompatibleAsset(
  command: "opencode" | "kilo",
  target: ProviderRuntimeTarget,
): string {
  const os = target.platform === "win32" ? "windows" : target.platform;
  const baseline = target.arch === "x64" && target.cpu === "baseline" ? "-baseline" : "";
  const musl = target.platform === "linux" && target.libc === "musl" ? "-musl" : "";
  const extension = target.platform === "linux" ? ".tar.gz" : ".zip";
  return `${command}-${os}-${target.arch}${baseline}${musl}${extension}`;
}

const codexRecipe: ProviderRuntimeRecipe = {
  provider: "codex",
  executableName: "codex",
  resolve: async (target, signal) => {
    const expected = codexAsset(target);
    const release = await resolveGithubAsset({
      repo: "openai/codex",
      releaseTag: "rust-v0.144.6",
      expectedVersion: "0.144.6",
      assetName: expected.name,
      signal,
    });
    return githubArtifact({
      provider: "codex",
      target,
      version: release.version,
      asset: release.asset,
      executablePath: expected.executablePath,
    });
  },
};

const claudeRecipe: ProviderRuntimeRecipe = {
  provider: "claudeAgent",
  executableName: "claude",
  resolve: async (target, signal) => {
    const base = "https://downloads.claude.ai/claude-code-releases";
    const version = "2.1.215";
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9._-]+)?$/u.test(version)) {
      throw new ProviderRuntimeRecipeError("Claude returned an invalid release version.");
    }
    const manifest = assertRecord(
      await fetchJson({
        url: `${base}/${version}/manifest.json`,
        signal,
        allowedHosts: ["downloads.claude.ai"],
      }),
      "Claude release manifest",
    );
    if (requiredString(manifest, "version", "Claude release manifest") !== version) {
      throw new ProviderRuntimeRecipeError("Claude release manifest version does not match.");
    }
    const platformKey = `${target.platform}-${target.arch}${
      target.platform === "linux" && target.libc === "musl" ? "-musl" : ""
    }`;
    const platforms = assertRecord(manifest.platforms, "Claude release platforms");
    const platform = assertRecord(platforms[platformKey], "Claude platform release");
    const binary = requiredString(platform, "binary", "Claude platform release");
    const checksum = requiredString(platform, "checksum", "Claude platform release");
    const size = optionalPositiveInt(platform, "size");
    return {
      provider: "claudeAgent",
      version,
      target,
      url: `${base}/${version}/${platformKey}/${binary}`,
      allowedHosts: ["downloads.claude.ai"],
      digestAlgorithm: "sha256",
      digest: checksum,
      ...(size ? { size } : {}),
      archiveFormat: "raw",
      executablePath: binary,
      smokeArgs: ["--version"],
      catalogRevision: `claude:${version}:${checksum}`,
    };
  },
};

function antigravityPlatform(target: ProviderRuntimeTarget): string {
  const arch = target.arch === "arm64" ? "arm64" : "amd64";
  if (target.platform === "linux" && target.libc === "musl") return `linux_${arch}_musl`;
  const os = target.platform === "win32" ? "windows" : target.platform;
  return `${os}_${arch}`;
}

const antigravityRecipe: ProviderRuntimeRecipe = {
  provider: "antigravity",
  executableName: "agy",
  resolve: async (target, signal) => {
    const manifestHost = "antigravity-cli-auto-updater-974169037036.us-central1.run.app";
    const platform = antigravityPlatform(target);
    const manifest = assertRecord(
      await fetchJson({
        url: `https://${manifestHost}/manifests/${platform}.json`,
        signal,
        allowedHosts: [manifestHost],
      }),
      "Antigravity release manifest",
    );
    const version = requiredString(manifest, "version", "Antigravity release manifest");
    if (version !== "1.1.4") {
      throw new ProviderRuntimeRecipeError(
        "A newer Antigravity release is available but has not yet passed Scient's runtime review.",
      );
    }
    const url = requiredString(manifest, "url", "Antigravity release manifest");
    const digest = requiredString(manifest, "sha512", "Antigravity release manifest");
    return {
      provider: "antigravity",
      version,
      target,
      url,
      allowedHosts: ["storage.googleapis.com"],
      digestAlgorithm: "sha512",
      digest,
      archiveFormat: target.platform === "win32" ? "raw" : "tar.gz",
      executablePath: target.platform === "win32" ? "antigravity.exe" : "antigravity",
      smokeArgs: ["--version"],
      catalogRevision: `antigravity:${version}:${digest}`,
    };
  },
};

const PINNED_GROK_MAC_ARM64 = {
  version: "0.2.106",
  url: "https://x.ai/cli/grok-0.2.106-macos-aarch64",
  size: 121_785_440,
  sha256: "7229f5e2a69b05832c86db82bebda541e92b5c24958fbfacf5c8f463394d3027",
} as const;

const grokRecipe: ProviderRuntimeRecipe = {
  provider: "grok",
  executableName: "grok",
  resolve: async (target, signal) => {
    if (target.platform !== "darwin" || target.arch !== "arm64") {
      throw new ProviderRuntimeRecipeError(
        "Scient has not yet reviewed a Grok managed runtime for this platform.",
      );
    }
    const latest = (
      await fetchText({
        url: "https://x.ai/cli/stable",
        signal,
        allowedHosts: ["x.ai"],
      })
    ).trim();
    if (latest !== PINNED_GROK_MAC_ARM64.version) {
      throw new ProviderRuntimeRecipeError(
        "A newer Grok release is available but has not yet passed Scient's runtime review.",
      );
    }
    return {
      provider: "grok",
      version: PINNED_GROK_MAC_ARM64.version,
      target,
      url: PINNED_GROK_MAC_ARM64.url,
      allowedHosts: ["x.ai", "storage.googleapis.com"],
      digestAlgorithm: "sha256",
      digest: PINNED_GROK_MAC_ARM64.sha256,
      size: PINNED_GROK_MAC_ARM64.size,
      archiveFormat: "raw",
      executablePath: "grok",
      smokeArgs: ["--version"],
      catalogRevision: `scient-pinned:grok:${PINNED_GROK_MAC_ARM64.version}`,
    };
  },
};

const PINNED_CURSOR_MAC_ARM64 = {
  version: "2026.07.16-899851b",
  url: "https://downloads.cursor.com/lab/2026.07.16-899851b/darwin/arm64/agent-cli-package.tar.gz",
  size: 69_589_145,
  sha256: "c0cd7b63c01fb63b44e33c7a2613432e8fd8cb13881da72ac1613c9f1408115f",
} as const;

const cursorRecipe: ProviderRuntimeRecipe = {
  provider: "cursor",
  executableName: "cursor-agent",
  resolve: async (target) => {
    if (target.platform !== "darwin" || target.arch !== "arm64") {
      throw new ProviderRuntimeRecipeError(
        "Scient has not yet reviewed a Cursor Agent managed runtime for this platform.",
      );
    }
    return {
      provider: "cursor",
      version: PINNED_CURSOR_MAC_ARM64.version,
      target,
      url: PINNED_CURSOR_MAC_ARM64.url,
      allowedHosts: ["downloads.cursor.com"],
      digestAlgorithm: "sha256",
      digest: PINNED_CURSOR_MAC_ARM64.sha256,
      size: PINNED_CURSOR_MAC_ARM64.size,
      archiveFormat: "tar.gz",
      executablePath: "dist-package/cursor-agent",
      smokeArgs: ["--version"],
      catalogRevision: `scient-pinned:cursor:${PINNED_CURSOR_MAC_ARM64.version}`,
    };
  },
};

async function resolveDroidVersion(signal: AbortSignal): Promise<string> {
  const script = await fetchText({
    url: "https://app.factory.ai/cli",
    signal,
    allowedHosts: ["app.factory.ai"],
  });
  const match = /^VER="([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9._-]+)?)"$/mu.exec(script);
  if (!match?.[1])
    throw new ProviderRuntimeRecipeError("Factory installer did not identify a release.");
  if (match[1] !== "0.175.0") {
    throw new ProviderRuntimeRecipeError(
      "A newer Factory Droid release is available but has not yet passed Scient's runtime review.",
    );
  }
  return match[1];
}

const droidRecipe: ProviderRuntimeRecipe = {
  provider: "droid",
  executableName: "droid",
  resolve: async (target, signal) => {
    const version = await resolveDroidVersion(signal);
    const os = target.platform === "win32" ? "windows" : target.platform;
    const arch = `${target.arch}${target.arch === "x64" && target.cpu === "baseline" ? "-baseline" : ""}`;
    const binary = target.platform === "win32" ? "droid.exe" : "droid";
    const base = `https://downloads.factory.ai/factory-cli/releases/${version}/${os}/${arch}/${binary}`;
    const checksum = (
      await fetchText({
        url: `${base}.sha256`,
        signal,
        allowedHosts: ["downloads.factory.ai"],
      })
    )
      .trim()
      .split(/\s+/u)[0];
    if (!checksum || !/^[a-fA-F0-9]{64}$/u.test(checksum)) {
      throw new ProviderRuntimeRecipeError("Factory returned an invalid runtime checksum.");
    }
    return {
      provider: "droid",
      version,
      target,
      url: base,
      allowedHosts: ["downloads.factory.ai"],
      digestAlgorithm: "sha256",
      digest: checksum.toLowerCase(),
      archiveFormat: "raw",
      executablePath: binary,
      smokeArgs: ["--version"],
      catalogRevision: `factory:${version}:${checksum.toLowerCase()}`,
    };
  },
};

function makeOpenCodeCompatibleRecipe(input: {
  readonly provider: "opencode" | "kilo";
  readonly repo: string;
  readonly releaseTag: string;
  readonly expectedVersion: string;
}): ProviderRuntimeRecipe {
  return {
    provider: input.provider,
    executableName: input.provider,
    resolve: async (target, signal) => {
      const assetName = openCodeCompatibleAsset(input.provider, target);
      const release = await resolveGithubAsset({
        repo: input.repo,
        releaseTag: input.releaseTag,
        expectedVersion: input.expectedVersion,
        assetName,
        signal,
      });
      return githubArtifact({
        provider: input.provider,
        target,
        version: release.version,
        asset: release.asset,
        executablePath: target.platform === "win32" ? `${input.provider}.exe` : input.provider,
      });
    },
  };
}

const piRecipe: ProviderRuntimeRecipe = {
  provider: "pi",
  executableName: "pi",
  bundled: true,
  resolve: async () => {
    throw new ProviderRuntimeRecipeError("Pi is built into Scient and does not need installation.");
  },
};

const recipes = new Map<ProviderKind, ProviderRuntimeRecipe>([
  ["codex", codexRecipe],
  ["claudeAgent", claudeRecipe],
  ["cursor", cursorRecipe],
  ["antigravity", antigravityRecipe],
  ["grok", grokRecipe],
  ["droid", droidRecipe],
  [
    "opencode",
    makeOpenCodeCompatibleRecipe({
      provider: "opencode",
      repo: "anomalyco/opencode",
      releaseTag: "v1.18.3",
      expectedVersion: "1.18.3",
    }),
  ],
  [
    "kilo",
    makeOpenCodeCompatibleRecipe({
      provider: "kilo",
      repo: "Kilo-Org/kilocode",
      releaseTag: "v7.4.11",
      expectedVersion: "7.4.11",
    }),
  ],
  ["pi", piRecipe],
]);

export function getProviderRuntimeRecipe(provider: ProviderKind): ProviderRuntimeRecipe {
  const recipe = recipes.get(provider);
  if (!recipe)
    throw new ProviderRuntimeRecipeError(`No managed runtime recipe exists for ${provider}.`);
  return recipe;
}

export const PROVIDER_RUNTIME_RECIPES: ReadonlyMap<ProviderKind, ProviderRuntimeRecipe> = recipes;
