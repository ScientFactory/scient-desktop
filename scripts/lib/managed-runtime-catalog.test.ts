import { describe, expect, it } from "vite-plus/test";
import {
  ANTIGRAVITY_ACP_TARGETS,
  antigravityAcpExecutableNames,
} from "@scientfactory/provider-runtime";

import {
  mergeQualifiedManagedRuntimeProvider,
  parseCursorInstallerVersion,
  parseDroidRssVersion,
  parseGrokStableVersion,
  refreshManagedRuntimeCatalog,
  refreshManagedRuntimeProvider,
  validateManagedRuntimeCatalog,
  type ManagedRuntimeCatalogData,
} from "./managed-runtime-catalog.ts";
import bundledCatalogJson from "../../apps/server/src/scient/providerLifecycle/bundled-managed-runtime-catalog.json" with { type: "json" };

const currentCatalog: ManagedRuntimeCatalogData = {
  schemaVersion: 1,
  providers: {
    codex: { contractRevision: 1, channel: "stable", version: "0.150.1", artifacts: {} },
    claudeAgent: { contractRevision: 1, channel: "stable", version: "2.1.251", artifacts: {} },
    antigravity: { contractRevision: 1, channel: "stable", version: "1.1.22", artifacts: {} },
    antigravityAcp: {
      contractRevision: 1,
      channel: "stable",
      version: "1.0.0",
      artifacts: {},
    },
    cursor: {
      contractRevision: 1,
      channel: "stable",
      version: "2026.08.25-3e8eec8",
      artifacts: {},
    },
    droid: { contractRevision: 1, channel: "stable", version: "0.208.1", artifacts: {} },
    grok: { contractRevision: 1, channel: "stable", version: "1.0.13", artifacts: {} },
  },
};

const unixAcpArchive = Buffer.from(
  "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWzLyU9OzFHISCzKSy0u5gIAUEsBAhQDFAAAAAgAAAAiXXMTL+gUAAAAFAAAABIAAAAAAAAAAAAAAO2BAAAAAGFneV9hY3Bfc2VydmVyLnBhclBLAQIUAxQAAAAIAAAAIl1fcgMpEAAAAA4AAAAVAAAAAAAAAAAAAADtgUQAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxQSwUGAAAAAAIAAgCDAAAAhwAAAAAA",
  "base64",
);
const windowsAcpArchive = Buffer.from(
  "UEsDBBQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAYWd5X2FjcF9zZXJ2ZXIuZXhlS8wryUwvSizLLKlUKCoFcnJTuQBQSwMEFAAAAAgAAAAiXV9yAykQAAAADgAAABkAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWwuZXhly8lPTsxRyEgsykstLuYCAFBLAQIUAxQAAAAIAAAAIl1zEy/oFAAAABQAAAASAAAAAAAAAAAAAADtgQAAAABhZ3lfYWNwX3NlcnZlci5leGVQSwECFAMUAAAACAAAACJdX3IDKRAAAAAOAAAAGQAAAAAAAAAAAAAA7YFEAAAAbG9jYWxoYXJuZXNzX2V4dGVybmFsLmV4ZVBLBQYAAAAAAgACAIcAAACLAAAAAAA=",
  "base64",
);

function acpRegistry(version: string, nativeVersion: string) {
  return {
    id: "antigravity-acp",
    version,
    distribution: {
      binary: Object.fromEntries(
        ANTIGRAVITY_ACP_TARGETS.map((target) => {
          const names = antigravityAcpExecutableNames(target.platform);
          return [
            target.registryKey,
            {
              archive: `https://dl.google.com/agy-extensions/releases/${target.directory}/agy-acp-server-${nativeVersion}-${target.archiveSuffix}.zip`,
              cmd: `./${names.executable}`,
            },
          ];
        }),
      ),
    },
  };
}

function nextPatch(version: string): string {
  const match = /^(.*\.)([0-9]+)$/u.exec(version);
  if (!match) throw new Error(`Test version '${version}' has no numeric patch component.`);
  return `${match[1]}${Number(match[2]) + 1}`;
}

function stableChannelFetch(codexVersion = "0.150.1") {
  const requested: string[] = [];
  const fetch_ = async (input: URL) => {
    const url = input.toString();
    requested.push(url);
    if (url === "https://releases.openai.com/codex/channels/latest") {
      return Response.json({ tag_name: `rust-v${codexVersion}` });
    }
    if (url === "https://downloads.claude.ai/claude-code-releases/latest") {
      return new Response("2.1.251");
    }
    if (url.endsWith("/manifests/darwin_arm64.json")) {
      return Response.json({ version: "1.1.22" });
    }
    if (url === "https://cursor.com/install") {
      return new Response(
        'DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.08.25-3e8eec8/${OS}/${ARCH}/agent-cli-package.tar.gz"',
      );
    }
    if (url === "https://docs.factory.ai/changelog/rss.xml") {
      return new Response("<title><![CDATA[CLI v0.208.1: fixes]]></title>");
    }
    if (url === "https://x.ai/cli/stable") return new Response("1.0.13");
    if (
      url ===
      "https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json"
    ) {
      return Response.json({ version: "1.0.0" });
    }
    throw new Error(`Unexpected release request: ${url}`);
  };
  return { fetch_, requested };
}

describe("managed runtime release discovery", () => {
  it("validates the generated catalog against every app-owned provider target", () => {
    const catalog = validateManagedRuntimeCatalog(bundledCatalogJson);
    expect(catalog.providers.codex?.version).toBe(bundledCatalogJson.providers.codex.version);
    expect(() =>
      validateManagedRuntimeCatalog({
        ...bundledCatalogJson,
        providers: {
          ...bundledCatalogJson.providers,
          codex: {
            ...bundledCatalogJson.providers.codex,
            artifacts: {
              ...bundledCatalogJson.providers.codex.artifacts,
              "plan9-mips": bundledCatalogJson.providers.codex.artifacts["darwin-arm64"],
            },
          },
        },
      }),
    ).toThrow(/unapproved targets/u);
  });

  it("extracts one unambiguous Cursor CLI release", () => {
    expect(
      parseCursorInstallerVersion(
        'DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.08.25-3e8eec8/${OS}/${ARCH}/agent-cli-package.tar.gz"',
      ),
    ).toBe("2026.08.25-3e8eec8");
    expect(() =>
      parseCursorInstallerVersion(
        "https://downloads.cursor.com/lab/1.0.0/${OS}/${ARCH}/x https://downloads.cursor.com/lab/2.0.0/${OS}/${ARCH}/x",
      ),
    ).toThrow(/unambiguous/u);
  });

  it("extracts the latest Droid CLI entry rather than a desktop-only release", () => {
    expect(
      parseDroidRssVersion(
        "<title><![CDATA[Factory notes]]></title><title><![CDATA[CLI v0.208.1, Desktop v0.165.1: fixes]]></title>",
      ),
    ).toBe("0.208.1");
    expect(() => parseDroidRssVersion("<title>Desktop v1.0.0</title>")).toThrow(/Droid/u);
  });

  it("accepts only a strict Grok stable version", () => {
    expect(parseGrokStableVersion("1.0.13\n")).toBe("1.0.13");
    expect(() => parseGrokStableVersion("latest")).toThrow(/invalid/u);
  });

  it("checks only stable pointers when every provider is current", async () => {
    const { fetch_, requested } = stableChannelFetch();
    const result = await refreshManagedRuntimeCatalog(currentCatalog, fetch_);
    expect(result.changedProviders).toEqual([]);
    expect(result.catalog).toEqual(currentCatalog);
    expect(requested).toHaveLength(7);
  });

  it("discovers one provider without coupling it to another provider channel", async () => {
    const { fetch_, requested } = stableChannelFetch();
    const result = await refreshManagedRuntimeProvider(currentCatalog, "codex", fetch_);
    expect(result.changedProviders).toEqual([]);
    expect(requested).toEqual(["https://releases.openai.com/codex/channels/latest"]);
  });

  it("discovers and inspects every approved ACP target as one release family", async () => {
    const registry = acpRegistry("1.1.0", "agy_acp_server_fixture");
    const requested: string[] = [];
    const result = await refreshManagedRuntimeProvider(
      currentCatalog,
      "antigravityAcp",
      async (input) => {
        const url = input.toString();
        requested.push(url);
        if (url.includes("raw.githubusercontent.com")) return Response.json(registry);
        return new Response(url.includes("windows") ? windowsAcpArchive : unixAcpArchive);
      },
    );

    expect(result.changedProviders).toEqual(["antigravityAcp"]);
    expect(result.catalog.providers.antigravityAcp?.version).toBe("1.1.0");
    expect(Object.keys(result.catalog.providers.antigravityAcp?.artifacts ?? {})).toHaveLength(5);
    expect(requested).toHaveLength(7);
  });

  it("discovers a missing ACP feed entry even when its version equals the bundled release", async () => {
    const current = validateManagedRuntimeCatalog(bundledCatalogJson);
    const { antigravityAcp: _bundledAcp, ...providers } = current.providers;
    const legacy = { ...current, providers };
    const version = bundledCatalogJson.providers.antigravityAcp.version;
    const registry = acpRegistry(version, "agy_acp_server_fixture");
    const result = await refreshManagedRuntimeProvider(legacy, "antigravityAcp", async (input) =>
      input.toString().includes("raw.githubusercontent.com")
        ? Response.json(registry)
        : new Response(input.toString().includes("windows") ? windowsAcpArchive : unixAcpArchive),
    );
    expect(result.changedProviders).toEqual(["antigravityAcp"]);
    expect(result.catalog.providers.antigravityAcp?.version).toBe(version);
    // Native qualification must still run before publication. A matching bundled
    // release can then initialize an older feed without waiting for another version.
    const promoted = mergeQualifiedManagedRuntimeProvider({
      current: legacy,
      candidate: validateManagedRuntimeCatalog(bundledCatalogJson),
      provider: "antigravityAcp",
    });
    expect(promoted.providers.antigravityAcp).toEqual(bundledCatalogJson.providers.antigravityAcp);
    expect("antigravityAcp" in legacy.providers).toBe(false);
  });

  it("merges only the qualified provider into the latest published catalog", () => {
    const catalog = validateManagedRuntimeCatalog(bundledCatalogJson);
    const codexVersion = nextPatch(catalog.providers.codex!.version);
    const claudeVersion = nextPatch(catalog.providers.claudeAgent!.version);
    const droidVersion = nextPatch(catalog.providers.droid!.version);
    const candidate: ManagedRuntimeCatalogData = {
      ...catalog,
      providers: {
        ...catalog.providers,
        codex: {
          ...catalog.providers.codex!,
          version: codexVersion,
        },
        claudeAgent: {
          ...catalog.providers.claudeAgent!,
          version: claudeVersion,
        },
      },
    };
    const latest: ManagedRuntimeCatalogData = {
      ...catalog,
      providers: {
        ...catalog.providers,
        droid: {
          ...catalog.providers.droid!,
          version: droidVersion,
        },
      },
    };
    const promoted = mergeQualifiedManagedRuntimeProvider({
      current: latest,
      candidate,
      provider: "codex",
    });
    expect(promoted.providers.codex?.version).toBe(codexVersion);
    expect(promoted.providers.droid?.version).toBe(droidVersion);
    expect(promoted.providers.claudeAgent?.version).toBe(latest.providers.claudeAgent?.version);
  });

  it("rejects same-version metadata replacement during publication", () => {
    const catalog = validateManagedRuntimeCatalog(bundledCatalogJson);
    const codex = catalog.providers.codex!;
    const darwin = codex.artifacts["darwin-arm64"]!;
    const candidate: ManagedRuntimeCatalogData = {
      ...catalog,
      providers: {
        ...catalog.providers,
        codex: {
          ...codex,
          artifacts: {
            ...codex.artifacts,
            "darwin-arm64": {
              ...darwin,
              checksum: { ...darwin.checksum, digest: "a".repeat(64) },
            },
          },
        },
      },
    };
    expect(() =>
      mergeQualifiedManagedRuntimeProvider({ current: catalog, candidate, provider: "codex" }),
    ).toThrow(/same-version catalog repack/u);
  });

  it("fails closed when an official stable pointer moves backwards", async () => {
    const { fetch_, requested } = stableChannelFetch("0.149.1");
    await expect(refreshManagedRuntimeCatalog(currentCatalog, fetch_)).rejects.toThrow(
      /moved backwards/u,
    );
    expect(requested).toEqual(["https://releases.openai.com/codex/channels/latest"]);
  });
});
