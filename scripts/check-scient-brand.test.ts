// @effect-diagnostics nodeBuiltinImport:off - The allowlist test reads the committed JSON file before an Effect runtime exists.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  brandRulesFor,
  checkBrand,
  findBrandViolations,
  isProductSurface,
  parseBrandAllowlist,
  type BrandAllowlistEntry,
} from "./check-scient-brand.ts";

const rulesHit = (path: string, contents: string) =>
  findBrandViolations([{ path, contents }]).map((violation) => violation.rule);

describe("Scient brand guard", () => {
  it("rejects inherited product copy on active application surfaces", () => {
    expect(
      findBrandViolations([
        { path: "apps/web/src/example.ts", contents: 'const label = "T3 Code";' },
      ]),
    ).toContainEqual({
      path: "apps/web/src/example.ts",
      line: 1,
      text: 'const label = "T3 Code";',
      rule: "inherited-brand",
    });
  });

  it.each([
    "packages/client-runtime/src/work-log/presentation.ts",
    "apps/mobile/src/lib/threadActivity.ts",
    "apps/mobile/src/features/threads/thread-work-log.tsx",
    "apps/mobile/src/components/CompactBrandTitle.tsx",
    "apps/mobile/src/lib/authClientMetadata.ts",
    "apps/mobile/src/features/settings/SettingsAboutRouteScreen.tsx",
  ])("covers owned tool presentation without expanding donor-wide enforcement: %s", (path) => {
    expect(rulesHit(path, 'const label = "Reading a T3 thread";')).toContain("inherited-brand");
  });

  it.each([
    'Tool.make("t3_thread_read", {})',
    'const title = "T3 MCP";',
    'const instructions = "Use the t3-code MCP server";',
  ])("rejects inherited public tool identity: %s", (contents) => {
    expect(rulesHit("apps/server/src/mcp/tools.ts", contents)).toContain("inherited-brand");
  });

  it("rejects an inherited visual wordmark even when its name is split from the copy", () => {
    expect(
      rulesHit(
        "apps/web/src/components/sidebar/SidebarChrome.tsx",
        "const Brand = () => <T3Wordmark />;",
      ),
    ).toEqual(["inherited-brand"]);
  });

  it("rejects the retired repository slug from active application surfaces", () => {
    expect(
      rulesHit(
        "apps/server/src/support.ts",
        'export const source = "ScientFactory/scient-desktop-next";',
      ),
    ).toEqual(["inherited-brand"]);
  });

  it.each(["pingdotgg/t3code", "t3dotgg/t3-code"])(
    "rejects upstream release links on active application surfaces (%s)",
    (repository) => {
      expect(
        rulesHit(
          "apps/web/src/components/desktopUpdate.logic.ts",
          `const releaseUrl = "https://github.com/${repository}/releases/tag/v0.6.8";`,
        ),
      ).toEqual(["inherited-brand"]);
    },
  );

  it("permits Scient releases and upstream source attribution", () => {
    expect(
      findBrandViolations([
        {
          path: "apps/web/src/components/desktopUpdate.logic.ts",
          contents:
            'const releaseUrl = "https://github.com/ScientFactory/scient-desktop/releases/tag/v0.6.8";',
        },
        {
          path: "apps/desktop/src/about.ts",
          contents: 'const upstream = "https://github.com/pingdotgg/t3code";',
        },
        {
          path: "apps/web/src/components/desktopUpdate.logic.ts",
          contents: "// Upstream source: https://github.com/pingdotgg/t3code/releases",
        },
      ]),
    ).toEqual([]);
  });

  it("permits technical commentary and donor-only surfaces", () => {
    expect(
      findBrandViolations([
        { path: "apps/server/src/example.ts", contents: "// T3 Code compatibility seam" },
        { path: "apps/mobile/src/example.ts", contents: 'const label = "T3 Code";' },
        { path: "apps/marketing/src/example.ts", contents: 'const label = "T3 Code";' },
      ]),
    ).toEqual([]);
  });

  it("preserves captured compatibility identities in test-only replay helpers", () => {
    const contents = 'const capturedClientTitle = "T3 Code";';
    expect(rulesHit("apps/server/src/provider/CodexAdapterV2.testkit.ts", contents)).toEqual([]);
    expect(rulesHit("apps/server/src/provider/CodexAdapterV2.ts", contents)).toContain(
      "inherited-brand",
    );
  });
});

describe("brand check scope", () => {
  it.each([
    "packages/shared/src/codexAuthCallback.ts",
    "packages/client-runtime/src/webhookAddress.ts",
    "packages/provider-acp/src/server/adapter.ts",
    "packages/source-control-gitcafe/src/server/GitCafePullRequestProvider.ts",
    "packages/scient-sources/src/index.ts",
    "native/browser-secret/main.c",
    "native/hyprland-snap-shot/src/feedback.rs",
    "apps/desktop/gnome-extension/extension.js",
    "docs/user/remote-access.md",
  ])("holds shipped surface %s to every rule", (path) => {
    expect(brandRulesFor(path)).toEqual(["inherited-brand", "bare-t3", "t3-connect", "t3-command"]);
  });

  it.each([
    "packages/provider-testing/src/index.ts",
    "packages/source-control-testing/src/index.ts",
    "native/libghostty-vt/include/ghostty/vt.h",
    "native/browser-secret/test.c",
    "native/kde-snap-shot/src/transport_tests.rs",
    "apps/server/src/orchestration-v2/testkit/fixtures/replay.ts",
    "apps/web/src/components/Example.test.tsx",
    "docs/internals/t3-connect.md",
    "apps/mobile/src/features/settings/SettingsAboutRouteScreen.md",
    "apps/server/src/provider/pi/NOTICE.md",
  ])("leaves %s out of the shipped-surface rules", (path) => {
    expect(brandRulesFor(path)).not.toContain("bare-t3");
  });

  it("keeps developer tooling and donor files to the inherited-brand rule", () => {
    expect(brandRulesFor("apps/server/scripts/cli.ts")).toEqual(["inherited-brand"]);
    expect(brandRulesFor("apps/mobile/src/Stack.tsx")).toEqual(["inherited-brand"]);
    expect(brandRulesFor("scripts/build-desktop-artifact.ts")).toEqual(["inherited-brand"]);
    expect(isProductSurface("apps/mobile/src/example.ts")).toBe(false);
  });
});

describe("bare T3 product name", () => {
  it.each([
    "throw new Error(`T3 could not install its headless browser.`);",
    'const message = "Refusing to signal the T3 server process.";',
    'const detail = "Check free disk space in T3\'s home directory.";',
    '<div class="brand"><strong>T3</strong> Code</div>',
    "            T3 needs your SSH password to connect to <code>{target}</code>.",
    "        Link an environment to make it available through T3",
  ])("rejects %s", (contents) => {
    expect(rulesHit("apps/server/src/example.ts", contents)).toContain("bare-t3");
  });

  it.each([
    "const home = process.env.T3CODE_HOME;",
    'import { x } from "@t3tools/shared/x";',
    'const file = "t3.json";',
    'const header = "x-t3-orchestration-protocol";',
    'const path = "/.well-known/t3/environment";',
    'const cookie = "t3_session";',
    'const link = "t3-thread://v1/thread";',
    'const key = "t3code:client-settings";',
    "const T3_PROJECT_FILE_NAME = name;",
  ])("permits retained identifier %s", (contents) => {
    expect(rulesHit("apps/server/src/example.ts", contents)).toEqual([]);
  });
});

describe("T3 Connect", () => {
  it("rejects T3 Connect on reachable surfaces", () => {
    expect(
      rulesHit(
        "packages/client-runtime/src/webhookAddress.ts",
        'note: "Link this environment to T3 Connect for a public URL.",',
      ),
    ).toEqual(["t3-connect"]);
  });

  it("is exempt only where a reviewed path entry names the switched-off cloud surface", () => {
    const contents = 'const title = "T3 Connect";';
    const allowlist: BrandAllowlistEntry[] = [
      {
        path: "apps/web/src/cloud/",
        rules: ["t3-connect"],
        kind: "dormant-cloud",
        reason: "Switched off.",
      },
    ];
    const result = checkBrand(
      [
        { path: "apps/web/src/cloud/linkEnvironment.ts", contents },
        { path: "apps/web/src/components/settings/ConnectionsSettings.tsx", contents },
      ],
      allowlist,
    );
    expect(result.violations.map((violation) => violation.path)).toEqual([
      "apps/web/src/components/settings/ConnectionsSettings.tsx",
    ]);
    expect(result.staleEntries).toEqual([]);
  });
});

describe("T3 command instructions", () => {
  it.each([
    "Create one in Settings, or run <code>t3 auth pairing create</code> on this machine.",
    "sudo t3 browser setup",
    'return { need: "sandbox", command: "sudo npx t3 browser setup" };',
    "Bun is unavailable. Please use Node.js (e.g. by running `npx t3`) instead.",
    "command={'npx --package=\"$SCIENT_SERVER_PACKAGE\" t3 pair'}",
    'label: Option.getOrElse(input.label, () => "t3 pair"),',
    'const spec = input || "t3@latest";',
    "description: `Reconnected on t3@${version}.`,",
  ])("rejects %s", (contents) => {
    expect(rulesHit("apps/web/src/example.tsx", contents)).toContain("t3-command");
  });

  it.each([
    'const file = "t3.json";',
    "Older Scient-installed `t3` shortcuts keep working.",
    'const branch = "t3code/pr-12/main";',
    "sudo scient browser setup",
    'npx --package="$SCIENT_SERVER_PACKAGE" scient pair',
  ])("permits %s", (contents) => {
    expect(rulesHit("docs/user/example.md", contents)).toEqual([]);
  });
});

describe("comments and fixtures", () => {
  it("skips JSX, block, trailing and Rust test-module commentary", () => {
    const contents = [
      "{/* T3 Code layout */}",
      "/*",
      " The T3 server owns this.",
      "*/",
      'const label = "Scient"; // T3 used to say otherwise',
      '/* T3 note */ const next = "T3 server";',
    ].join("\n");
    expect(findBrandViolations([{ path: "apps/web/src/example.tsx", contents }])).toEqual([
      {
        path: "apps/web/src/example.tsx",
        line: 6,
        text: '/* T3 note */ const next = "T3 server";',
        rule: "bare-t3",
      },
    ]);
    const rust = [
      'const NAME: &str = "Scient";',
      "#[cfg(test)]",
      "mod tests {",
      '  "T3"',
      "}",
    ].join("\n");
    expect(rulesHit("native/hyprland-snap-shot/src/ipc.rs", rust)).toEqual([]);
  });

  it("reads user documentation as written", () => {
    expect(rulesHit("docs/user/example.md", "* The T3 server restarts.")).toEqual(["bare-t3"]);
  });
});

describe("reviewed allowlist", () => {
  const compatibility =
    'const THREAD_READ_OBJECTS = [" a Scient thread", " a T3 thread"] as const;';
  const entry: BrandAllowlistEntry = {
    path: "apps/web/src/components/chat/MessagesTimeline.logic.ts",
    line: compatibility,
    rules: ["inherited-brand", "bare-t3"],
    kind: "compat",
    reason: "Recognizes older servers' titles.",
  };

  it("exempts only the exact line, file and rules it names", () => {
    const publicCopy = 'const label = "Reading a T3 thread";';
    const result = checkBrand(
      [
        { path: entry.path, contents: `${compatibility}\n${publicCopy}` },
        { path: "apps/web/src/other.ts", contents: compatibility },
      ],
      [entry],
    );
    expect(
      result.violations.map((violation) => `${violation.path}:${String(violation.line)}`),
    ).toEqual([
      `${entry.path}:2`,
      `${entry.path}:2`,
      "apps/web/src/other.ts:1",
      "apps/web/src/other.ts:1",
    ]);
    expect(result.staleEntries).toEqual([]);
  });

  it("reports entries that no longer exempt anything", () => {
    const result = checkBrand([{ path: entry.path, contents: 'const label = "Scient";' }], [entry]);
    expect(result.violations).toEqual([]);
    expect(result.staleEntries).toEqual([entry]);
  });

  it("requires every entry to name its rules, kind and reason", () => {
    expect(() =>
      parseBrandAllowlist(JSON.stringify([{ path: "a.ts", rules: ["bare-t3"], kind: "compat" }])),
    ).toThrow("needs a reason");
    expect(() =>
      parseBrandAllowlist(
        JSON.stringify([{ path: "a.ts", rules: ["t3-brand"], kind: "compat", reason: "x" }]),
      ),
    ).toThrow("needs rules");
    expect(() => parseBrandAllowlist("{}")).toThrow("must be a JSON array");
  });

  it("parses the committed allowlist", () => {
    const entries = parseBrandAllowlist(
      NodeFS.readFileSync(new URL("./scient-brand-allowlist.json", import.meta.url), "utf8"),
    );
    expect(entries.length).toBeGreaterThan(0);
  });
});
