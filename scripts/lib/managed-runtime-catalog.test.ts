import { describe, expect, it } from "vite-plus/test";
import {
  ANTIGRAVITY_ACP_TARGETS,
  MANAGED_RUNTIME_CATALOG_PROVIDERS,
  MANAGED_RUNTIME_POLICY,
  antigravityAcpExecutableNames,
} from "@scientfactory/provider-runtime";

import {
  mergeQualifiedManagedRuntimeProvider,
  parseCursorInstallerVersion,
  parseDroidStableVersion,
  parseGrokStableVersion,
  refreshManagedRuntimeCatalog,
  refreshManagedRuntimeProvider,
  validateManagedRuntimeCatalog,
  validateManagedRuntimeCandidate,
  type ManagedRuntimeCatalogData,
} from "./managed-runtime-catalog.ts";
import bundledCatalogJson from "../../apps/server/src/scient/providerLifecycle/bundled-managed-runtime-catalog.json" with { type: "json" };

const currentCatalog: ManagedRuntimeCatalogData = validateManagedRuntimeCatalog(bundledCatalogJson);

const previousCodexCatalog = (): ManagedRuntimeCatalogData => ({
  ...currentCatalog,
  providers: {
    ...currentCatalog.providers,
    codex: { ...currentCatalog.providers.codex!, contractRevision: 1 },
  },
});

describe("managed runtime policy transitions", () => {
  it("keeps every bundled family aligned with the shared policy registry", () => {
    for (const provider of MANAGED_RUNTIME_CATALOG_PROVIDERS) {
      const policy = MANAGED_RUNTIME_POLICY[provider];
      expect(currentCatalog.providers[provider]?.contractRevision).toBe(policy.revision);
      expect(
        policy.historicalRevisions.every((revision) => revision > 0 && revision < policy.revision),
      ).toBe(true);
    }
  });

  it("preserves the old published revision while other providers discover and publish", async () => {
    const current = validateManagedRuntimeCatalog(previousCodexCatalog());
    expect(current.providers.codex?.contractRevision).toBe(1);
    const { fetch_ } = stableChannelFetch();
    const unchanged = await refreshManagedRuntimeProvider(current, "claudeAgent", fetch_);
    expect(unchanged.changedProviders).toEqual([]);
    const claude = currentCatalog.providers.claudeAgent!;
    const candidate = {
      ...currentCatalog,
      providers: {
        ...currentCatalog.providers,
        claudeAgent: { ...claude, version: nextPatch(claude.version) },
      },
    };
    const published = mergeQualifiedManagedRuntimeProvider({
      current,
      candidate,
      provider: "claudeAgent",
    });
    expect(published.providers.codex).toEqual(current.providers.codex);
    expect(published.providers.claudeAgent?.version).toBe(nextPatch(claude.version));
  });

  it("rediscovers complete metadata when only the contract changed", async () => {
    const current = validateManagedRuntimeCatalog(previousCodexCatalog());
    const codex = current.providers.codex!;
    const requested: string[] = [];
    const result = await refreshManagedRuntimeProvider(current, "codex", async (input, init) => {
      requested.push(input.toString());
      if (init?.method === "HEAD")
        return new Response(null, { headers: { "content-length": "123456" } });
      return Response.json({
        tag_name: `rust-v${codex.version}`,
        assets: Object.values(codex.artifacts).map((artifact) => ({
          name: artifact.artifactName,
          browser_download_url: artifact.url,
          digest: `sha256:${artifact.checksum.digest}`,
        })),
      });
    });
    expect(result.changedProviders).toEqual(["codex"]);
    expect(result.catalog.providers.codex?.contractRevision).toBe(3);
    expect(result.catalog.providers.codex?.version).toBe(codex.version);
    expect(requested).toHaveLength(2 + Object.keys(codex.artifacts).length);
    expect(current.providers.codex?.contractRevision).toBe(1);
  });

  it("retains historical policy data without qualifying it against today's installer", () => {
    const previous = previousCodexCatalog();
    const codex = previous.providers.codex!;
    const historical = {
      ...codex,
      artifacts: { "former-target": codex.artifacts["darwin-arm64"]! },
    };
    const decoded = validateManagedRuntimeCatalog({
      ...previous,
      providers: { ...previous.providers, codex: historical },
    });
    expect(decoded.providers.codex).toEqual(historical);
    expect(() => validateManagedRuntimeCandidate(decoded, "codex")).toThrow(
      /current managed runtime contract/u,
    );
    const revisionTwo = validateManagedRuntimeCatalog({
      ...decoded,
      providers: { codex: { ...historical, contractRevision: 2 } },
    });
    expect(revisionTwo.providers.codex?.contractRevision).toBe(2);
    expect(() => validateManagedRuntimeCandidate(revisionTwo, "codex")).toThrow(
      /current managed runtime contract/u,
    );
    expect(() =>
      validateManagedRuntimeCatalog({
        ...decoded,
        providers: { codex: { ...historical, contractRevision: 3 } },
      }),
    ).toThrow(/unapproved target/u);
  });

  it("promotes a qualified policy-only transition idempotently and preserves other providers", () => {
    const current = validateManagedRuntimeCatalog(previousCodexCatalog());
    const promoted = mergeQualifiedManagedRuntimeProvider({
      current,
      candidate: currentCatalog,
      provider: "codex",
    });
    expect(promoted).toEqual(currentCatalog);
    expect(
      mergeQualifiedManagedRuntimeProvider({
        current: promoted,
        candidate: currentCatalog,
        provider: "codex",
      }),
    ).toBe(promoted);
  });

  it("never lets a contract change authorize repacking or deleting an existing artifact", () => {
    const current = validateManagedRuntimeCatalog(previousCodexCatalog());
    const codex = currentCatalog.providers.codex!;
    const artifact = codex.artifacts["darwin-arm64"]!;
    const candidate = {
      ...currentCatalog,
      providers: {
        ...currentCatalog.providers,
        codex: {
          ...codex,
          artifacts: {
            ...codex.artifacts,
            "darwin-arm64": { ...artifact, size: artifact.size + 1 },
          },
        },
      },
    };
    expect(() =>
      mergeQualifiedManagedRuntimeProvider({ current, candidate, provider: "codex" }),
    ).toThrow(/same-version catalog repack/u);
    const { "darwin-arm64": _removed, ...remaining } = codex.artifacts;
    expect(() =>
      validateManagedRuntimeCandidate(
        { ...candidate, providers: { codex: { ...codex, artifacts: remaining } } },
        "codex",
      ),
    ).toThrow(/every app-approved target/u);
  });

  it.each([0, 4, 999])("rejects unknown Codex contract %s", (contractRevision) => {
    expect(() =>
      validateManagedRuntimeCatalog({
        ...currentCatalog,
        providers: { codex: { ...currentCatalog.providers.codex!, contractRevision } },
      }),
    ).toThrow(/unsupported managed runtime contract/u);
  });

  it("never qualifies or publishes an older contract through the new installer", () => {
    const legacy = validateManagedRuntimeCatalog(previousCodexCatalog());
    expect(() => validateManagedRuntimeCandidate(legacy, "codex")).toThrow(
      /current managed runtime contract/u,
    );
    expect(() =>
      mergeQualifiedManagedRuntimeProvider({
        current: currentCatalog,
        candidate: legacy,
        provider: "codex",
      }),
    ).toThrow(/current managed runtime contract/u);
  });

  it("does not downgrade a provider version when its policy changes", () => {
    const current = previousCodexCatalog();
    const codex = current.providers.codex!;
    const newer = {
      ...current,
      providers: { ...current.providers, codex: { ...codex, version: nextPatch(codex.version) } },
    };
    expect(() =>
      mergeQualifiedManagedRuntimeProvider({
        current: newer,
        candidate: currentCatalog,
        provider: "codex",
      }),
    ).toThrow(/not newer/u);
  });
});

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

function stableChannelFetch(codexVersion = bundledCatalogJson.providers.codex.version) {
  const requested: string[] = [];
  const fetch_ = async (input: URL) => {
    const url = input.toString();
    requested.push(url);
    if (url === "https://releases.openai.com/codex/channels/latest") {
      return Response.json({ tag_name: `rust-v${codexVersion}` });
    }
    if (url === "https://downloads.claude.ai/claude-code-releases/latest") {
      return new Response(bundledCatalogJson.providers.claudeAgent.version);
    }
    if (url.endsWith("/manifests/darwin_arm64.json")) {
      return Response.json({ version: bundledCatalogJson.providers.antigravity.version });
    }
    if (url === "https://cursor.com/install") {
      return new Response(
        `DOWNLOAD_URL="https://downloads.cursor.com/lab/${bundledCatalogJson.providers.cursor.version}/\${OS}/\${ARCH}/agent-cli-package.tar.gz"`,
      );
    }
    if (url === "https://downloads.factory.ai/factory-cli/LATEST") {
      return new Response(`${bundledCatalogJson.providers.droid.version}\n`);
    }
    if (url === "https://x.ai/cli/stable")
      return new Response(bundledCatalogJson.providers.grok.version);
    if (
      url ===
      "https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json"
    ) {
      return Response.json({ version: bundledCatalogJson.providers.antigravityAcp.version });
    }
    if (url === "https://api.github.com/repos/earendil-works/pi/releases/latest")
      return Response.json({
        tag_name: `v${bundledCatalogJson.providers.pi.version}`,
        draft: false,
        prerelease: false,
      });
    throw new Error(`Unexpected release request: ${url}`);
  };
  return { fetch_, requested };
}

describe("managed runtime release discovery", () => {
  it("validates the generated catalog against every app-owned provider target", () => {
    const catalog = validateManagedRuntimeCatalog(bundledCatalogJson);
    expect(Object.keys(catalog.providers)).toEqual([...MANAGED_RUNTIME_CATALOG_PROVIDERS]);
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

  it("preserves an approved older target subset until its provider is requalified", () => {
    const pi = bundledCatalogJson.providers.pi;
    const legacy = validateManagedRuntimeCatalog({
      ...bundledCatalogJson,
      providers: {
        ...bundledCatalogJson.providers,
        pi: { ...pi, artifacts: { "darwin-arm64": pi.artifacts["darwin-arm64"] } },
      },
    });
    expect(Object.keys(legacy.providers.pi!.artifacts)).toEqual(["darwin-arm64"]);
    expect(() =>
      validateManagedRuntimeCatalog({
        ...bundledCatalogJson,
        providers: {
          ...bundledCatalogJson.providers,
          pi: { ...pi, artifacts: {} },
        },
      }),
    ).toThrow(/does not contain any app-approved targets/u);
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

  it("reads the native Droid stable pointer and rejects changelog text", () => {
    expect(parseDroidStableVersion("0.213.0\n")).toBe("0.213.0");
    expect(() => parseDroidStableVersion("<title>CLI v0.209.0</title>")).toThrow(/Droid/u);
  });

  it("allows an older feed without Pi without seeding or blocking other providers", async () => {
    const { pi: _pi, ...providers } = bundledCatalogJson.providers;
    const legacy = validateManagedRuntimeCatalog({ ...bundledCatalogJson, providers });
    expect(legacy.providers.pi).toBeUndefined();
    const { fetch_, requested } = stableChannelFetch(providers.codex.version);
    const result = await refreshManagedRuntimeProvider(legacy, "codex", fetch_);
    expect(result.changedProviders).toEqual([]);
    expect(result.catalog.providers.pi).toBeUndefined();
    expect(requested).toEqual(["https://releases.openai.com/codex/channels/latest"]);
    const promoted = mergeQualifiedManagedRuntimeProvider({
      current: legacy,
      candidate: legacy,
      provider: "codex",
    });
    expect(promoted.providers.pi).toBeUndefined();
    expect(
      mergeQualifiedManagedRuntimeProvider({
        current: legacy,
        candidate: validateManagedRuntimeCatalog(bundledCatalogJson),
        provider: "pi",
      }).providers.pi,
    ).toEqual(bundledCatalogJson.providers.pi);
  });

  it.each(MANAGED_RUNTIME_CATALOG_PROVIDERS)(
    "bootstraps only the qualified missing %s entry",
    (provider) => {
      const current = validateManagedRuntimeCatalog(bundledCatalogJson);
      const providers = { ...current.providers };
      delete providers[provider];
      const legacy = validateManagedRuntimeCatalog({ ...current, providers });
      expect(legacy.providers[provider]).toBeUndefined();
      expect(
        mergeQualifiedManagedRuntimeProvider({ current: legacy, candidate: current, provider }),
      ).toEqual(current);
    },
  );

  it("still rejects malformed or unapproved provider entries", () => {
    expect(() =>
      validateManagedRuntimeCatalog({
        ...bundledCatalogJson,
        providers: { ...bundledCatalogJson.providers, pi: {} },
      }),
    ).toThrow(/pi/u);
    expect(() =>
      validateManagedRuntimeCatalog({
        ...bundledCatalogJson,
        providers: { ...bundledCatalogJson.providers, unapproved: bundledCatalogJson.providers.pi },
      }),
    ).toThrow(/unknown providers/u);
  });

  it.each([false, true])("discovers missing Pi before qualification (newer=%s)", async (newer) => {
    const { pi, ...providers } = bundledCatalogJson.providers;
    const legacy = validateManagedRuntimeCatalog({ ...bundledCatalogJson, providers });
    const version = newer ? nextPatch(pi.version) : pi.version;
    const releaseArtifacts = Object.values(pi.artifacts).map((artifact) => ({
      ...artifact,
      url: artifact.url.replace(`/v${pi.version}/`, `/v${version}/`),
    }));
    const requested: string[] = [];
    const result = await refreshManagedRuntimeProvider(legacy, "pi", async (input, init) => {
      const url = input.toString();
      requested.push(url);
      if (url === "https://api.github.com/repos/earendil-works/pi/releases/latest") {
        return Response.json({
          tag_name: `v${version}`,
          draft: false,
          prerelease: false,
          assets: releaseArtifacts.map((artifact) => ({
            name: artifact.artifactName,
            browser_download_url: artifact.url,
            digest: `sha256:${artifact.checksum.digest}`,
          })),
        });
      }
      const artifact = releaseArtifacts.find((value) => value.url === url);
      expect(artifact).toBeDefined();
      expect(init?.method).toBe("HEAD");
      return new Response(null, { headers: { "content-length": String(artifact!.size) } });
    });
    expect(result.changedProviders).toEqual(["pi"]);
    expect(result.catalog.providers.pi?.version).toBe(version);
    expect(Object.keys(result.catalog.providers.pi!.artifacts)).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64-glibc",
      "linux-x64-glibc",
      "win32-arm64",
      "win32-x64",
    ]);
    expect(requested).toHaveLength(8);
    expect(legacy.providers.pi).toBeUndefined();
    const promoted = mergeQualifiedManagedRuntimeProvider({
      current: legacy,
      candidate: result.catalog,
      provider: "pi",
    });
    expect(promoted.providers.pi?.version).toBe(version);
    expect(promoted.providers.codex).toEqual(legacy.providers.codex);
  });

  it("discovers and promotes a qualified same-version target expansion", async () => {
    const full = validateManagedRuntimeCatalog(bundledCatalogJson);
    const pi = bundledCatalogJson.providers.pi;
    const current = validateManagedRuntimeCatalog({
      ...bundledCatalogJson,
      providers: {
        ...bundledCatalogJson.providers,
        pi: { ...pi, artifacts: { "darwin-arm64": pi.artifacts["darwin-arm64"] } },
      },
    });
    const artifacts = Object.values(pi.artifacts);
    const result = await refreshManagedRuntimeProvider(current, "pi", async (input, init) => {
      const url = input.toString();
      if (url === "https://api.github.com/repos/earendil-works/pi/releases/latest") {
        return Response.json({
          tag_name: `v${pi.version}`,
          draft: false,
          prerelease: false,
          assets: artifacts.map((artifact) => ({
            name: artifact.artifactName,
            browser_download_url: artifact.url,
            digest: `sha256:${artifact.checksum.digest}`,
          })),
        });
      }
      const artifact = artifacts.find((value) => value.url === url);
      expect(artifact).toBeDefined();
      expect(init?.method).toBe("HEAD");
      return new Response(null, { headers: { "content-length": String(artifact!.size) } });
    });
    expect(result.changedProviders).toEqual(["pi"]);
    expect(result.catalog.providers.pi).toEqual(full.providers.pi);
    expect(
      mergeQualifiedManagedRuntimeProvider({ current, candidate: result.catalog, provider: "pi" })
        .providers.pi,
    ).toEqual(full.providers.pi);
  });

  it("keeps same-version expansion additive and immutable", () => {
    const candidate = validateManagedRuntimeCatalog(bundledCatalogJson);
    const pi = bundledCatalogJson.providers.pi;
    const current = validateManagedRuntimeCatalog({
      ...bundledCatalogJson,
      providers: {
        ...bundledCatalogJson.providers,
        pi: { ...pi, artifacts: { "darwin-arm64": pi.artifacts["darwin-arm64"] } },
      },
    });
    const changedExisting: ManagedRuntimeCatalogData = {
      ...candidate,
      providers: {
        ...candidate.providers,
        pi: {
          ...candidate.providers.pi!,
          artifacts: {
            ...candidate.providers.pi!.artifacts,
            "darwin-arm64": {
              ...candidate.providers.pi!.artifacts["darwin-arm64"]!,
              checksum: { algorithm: "sha256", digest: "a".repeat(64) },
            },
          },
        },
      },
    };
    expect(() =>
      mergeQualifiedManagedRuntimeProvider({
        current,
        candidate: changedExisting,
        provider: "pi",
      }),
    ).toThrow(/same-version catalog repack/u);
    const incomplete: ManagedRuntimeCatalogData = {
      ...candidate,
      providers: {
        ...candidate.providers,
        pi: {
          ...candidate.providers.pi!,
          artifacts: {
            "darwin-arm64": candidate.providers.pi!.artifacts["darwin-arm64"]!,
            "darwin-x64": candidate.providers.pi!.artifacts["darwin-x64"]!,
          },
        },
      },
    };
    expect(() =>
      mergeQualifiedManagedRuntimeProvider({ current, candidate: incomplete, provider: "pi" }),
    ).toThrow(/every app-approved target/u);
  });

  it("rejects an incomplete newer release during publication", () => {
    const current = validateManagedRuntimeCatalog(bundledCatalogJson);
    const pi = current.providers.pi!;
    const candidate = validateManagedRuntimeCatalog({
      ...current,
      providers: {
        ...current.providers,
        pi: {
          ...pi,
          version: nextPatch(pi.version),
          artifacts: { "darwin-arm64": pi.artifacts["darwin-arm64"] },
        },
      },
    });
    expect(() =>
      mergeQualifiedManagedRuntimeProvider({ current, candidate, provider: "pi" }),
    ).toThrow(/every app-approved target/u);
  });

  it("discovers every existing Droid target from its native channel", async () => {
    const current = validateManagedRuntimeCatalog(bundledCatalogJson);
    const version = nextPatch(current.providers.droid!.version);
    const result = await refreshManagedRuntimeProvider(current, "droid", async (input, init) => {
      const url = input.toString();
      if (url === "https://downloads.factory.ai/factory-cli/LATEST")
        return new Response(`${version}\n`);
      expect(url).toContain(`/factory-cli/releases/${version}/`);
      if (url.endsWith(".sha256")) return new Response("a".repeat(64));
      expect(init?.method).toBe("HEAD");
      return new Response(null, { headers: { "content-length": "100000000" } });
    });
    expect(result.changedProviders).toEqual(["droid"]);
    expect(result.catalog.providers.droid?.version).toBe(version);
    expect(Object.keys(result.catalog.providers.droid!.artifacts)).toHaveLength(6);
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
    expect(requested).toHaveLength(8);
  });

  it("discovers one provider without coupling it to another provider channel", async () => {
    const { fetch_, requested } = stableChannelFetch();
    const result = await refreshManagedRuntimeProvider(currentCatalog, "codex", fetch_);
    expect(result.changedProviders).toEqual([]);
    expect(requested).toEqual(["https://releases.openai.com/codex/channels/latest"]);
  });

  it("discovers and inspects every approved ACP target as one release family", async () => {
    const registry = acpRegistry("1.2.0", "agy_acp_server_fixture");
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
    expect(result.catalog.providers.antigravityAcp?.version).toBe("1.2.0");
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

  it("rejects a missing family's release below its bundled baseline before collecting artifacts", async () => {
    const current = validateManagedRuntimeCatalog(bundledCatalogJson);
    const { pi: _pi, ...providers } = current.providers;
    let requests = 0;
    await expect(
      refreshManagedRuntimeProvider({ ...current, providers }, "pi", async () => {
        requests++;
        return Response.json({ tag_name: "v0.1.0", draft: false, prerelease: false });
      }),
    ).rejects.toThrow(/moved backwards/u);
    expect(requests).toBe(1);
  });
});
