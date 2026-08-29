import { describe, expect, it } from "vite-plus/test";

import {
  parseCursorInstallerVersion,
  parseDroidRssVersion,
  parseGrokStableVersion,
  qualificationMatrix,
  refreshManagedRuntimeCatalog,
  type ManagedRuntimeCatalogData,
} from "./managed-runtime-catalog.ts";

const currentCatalog: ManagedRuntimeCatalogData = {
  schemaVersion: 1,
  providers: {
    codex: { contractRevision: 1, channel: "stable", version: "0.150.1", artifacts: {} },
    claudeAgent: { contractRevision: 1, channel: "stable", version: "2.1.251", artifacts: {} },
    antigravity: { contractRevision: 1, channel: "stable", version: "1.1.22", artifacts: {} },
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
    throw new Error(`Unexpected release request: ${url}`);
  };
  return { fetch_, requested };
}

describe("managed runtime release discovery", () => {
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

  it("qualifies every changed provider on the four native runner families", () => {
    expect(qualificationMatrix(["codex", "grok"])).toHaveLength(8);
    expect(qualificationMatrix(["codex"])).toEqual([
      { provider: "codex", runner: "macos-26" },
      { provider: "codex", runner: "macos-15-intel" },
      { provider: "codex", runner: "ubuntu-24.04" },
      { provider: "codex", runner: "windows-2025" },
    ]);
  });

  it("checks only stable pointers when every provider is current", async () => {
    const { fetch_, requested } = stableChannelFetch();
    const result = await refreshManagedRuntimeCatalog(currentCatalog, fetch_);
    expect(result.changedProviders).toEqual([]);
    expect(result.catalog).toEqual(currentCatalog);
    expect(requested).toHaveLength(6);
  });

  it("fails closed when an official stable pointer moves backwards", async () => {
    const { fetch_, requested } = stableChannelFetch("0.149.1");
    await expect(refreshManagedRuntimeCatalog(currentCatalog, fetch_)).rejects.toThrow(
      /moved backwards/u,
    );
    expect(requested).toEqual(["https://releases.openai.com/codex/channels/latest"]);
  });
});
