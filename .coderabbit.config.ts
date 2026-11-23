import { defineConfig, type CodeRabbitContext } from "@coderabbitai/config";

const approvability = `Fail when a maintainer should read this pull request before CodeRabbit approves it, and name the rule and file. Fail if it:

- Changes a product default: a setting's default value, or what users get without opting in. Making a feature do what it already promises is a bug fix, not a default change.
- Adds or broadens a directive that disables or suppresses a lint, type-checker, LSP, or other static-analysis diagnostic, including file-level, line-level, and configuration-level overrides.
- Adds a subsystem or user workflow, or is a large refactor across apps or packages.
- Changes packages/contracts or persisted data in a way that existing clients or stored data might not accept.
- Changes authentication, pairing, credentials, secrets, or remote connection trust.
- Adds or changes an external side effect, such as acting on GitHub, publishing a release, or calling a webhook.
- Adds, upgrades, or patches a dependency.
- Changes CI or release configuration, agent or contributor instructions, or any review tool's configuration, including .github/, AGENTS.md, CONTRIBUTING.md, .agents/, and .coderabbit.config.ts.

Otherwise pass. A focused bug fix, copy or layout fix, revert, or docs-only or test-only change passes unless a rule above applies. If you cannot decide, fail rather than report inconclusive. When failing, say that the pull request needs a maintainer's review.
`;

// Org members and collaborators merge their own pull requests. On anyone else's, CodeRabbit
// requests changes until its comments are resolved and its checks pass, then approves.
const UNGATED_AUTHORS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const isGated = ({ pr }: CodeRabbitContext) => !UNGATED_AUTHORS.has(pr?.authorAssociation ?? "");

const DOC_RULES = [
  {
    files: "docs/internals/01_architecture.md",
    applyTo:
      "{apps/server/src/orchestration-v2,apps/server/src/checkpointing,packages/contracts/src,apps/desktop/src/snapShot}/**/*.ts",
    instructions:
      "Hold changed code to the architectural boundaries in docs/internals/01_architecture.md.",
  },
  {
    files: "docs/internals/02_effect-services.md",
    applyTo: "{apps,packages,infra}/**/*.ts",
    instructions: "Hold changed code to the rules in docs/internals/02_effect-services.md.",
  },
  {
    files: "docs/internals/03_providers.md",
    applyTo:
      "{packages/provider-*,apps/server/src/provider,apps/server/src/orchestration-v2/Adapters}/**/*.{ts,json}",
    instructions:
      "Hold provider changes to docs/internals/03_providers.md, including strict ACP spec compliance for non-first-party agents and bumping updatedAt on model-manifest.json edits.",
  },
  {
    files: "docs/internals/04_environment-auth.md",
    applyTo:
      "{apps/server/src/auth,apps/server/src/mcp,apps/server/src/guest,apps/server/src/assets,apps/server/src/workspace}/**/*.ts",
    instructions:
      "Hold auth, MCP, guest link, and filesystem boundary changes to docs/internals/04_environment-auth.md.",
  },
  {
    files: "docs/internals/05_remote.md",
    applyTo:
      "{apps/server/src/peer,apps/server/src/environment,packages/ssh,packages/tailscale,apps/desktop/src/preview,apps/desktop/src/ssh}/**/*.ts",
    instructions:
      "Hold remote route, peer link, SSH, and preview tunnel changes to docs/internals/05_remote.md.",
  },
  {
    files: "docs/internals/06_t3-connect.md",
    applyTo: "{infra/relay/src,apps/server/src/cloud}/**/*.ts",
    instructions: "Hold relay and T3 Connect changes to docs/internals/06_t3-connect.md.",
  },
  {
    files: "SECURITY.md",
    applyTo:
      "{apps/server/src/auth,apps/server/src/mcp,apps/server/src/guest,apps/server/src/assets,apps/server/src/peer,apps/server/src/cloud,apps/server/src/policy,infra/relay/src}/**/*.ts",
    instructions:
      "Check security boundary changes against the trust model and real-finding criteria in SECURITY.md.",
  },
  {
    files: "docs/internals/07_server-updates.md",
    applyTo:
      "apps/server/src/{serviceLauncher.ts,desktopUpdate/**,cloud/serviceSelectionLock.ts,orchestration-v2/ProviderRuntimeRecoveryService.ts,orchestration-v2/RestartContinuation.ts}",
    instructions:
      "Hold update, rollback, and restart-recovery changes to docs/internals/07_server-updates.md.",
  },
  {
    files: "docs/internals/08_product-analytics.md",
    applyTo: "{apps/server/src/telemetry,apps/server/src/feedback}/**/*.ts",
    instructions:
      "Hold analytics identity, attribution, and privacy boundaries to docs/internals/08_product-analytics.md.",
  },
  {
    files: "docs/internals/09_connection-runtime.md",
    applyTo: "packages/client-runtime/src/**/*.ts",
    instructions:
      "Hold connection, sync, and cache changes to docs/internals/09_connection-runtime.md.",
  },
  {
    files: "docs/internals/10_web-ui.md",
    applyTo: "apps/web/src/**/*.{tsx,css}",
    instructions: "Hold changed code to the rules in docs/internals/10_web-ui.md.",
  },
  {
    files: "docs/internals/11_mobile-layout.md",
    applyTo: "apps/mobile/src/**/*.{ts,tsx}",
    instructions: "Hold mobile layout and pane changes to docs/internals/11_mobile-layout.md.",
  },
  {
    files: "docs/internals/12_mobile-navigation.md",
    applyTo: "apps/mobile/{src,modules}/**/*.{ts,tsx,swift,kt}",
    instructions:
      "Hold mobile navigation, native header, and media presentation changes to docs/internals/12_mobile-navigation.md.",
  },
  {
    files: "docs/internals/13_mobile-development.md",
    applyTo: "apps/mobile/{src/lib,modules,scripts}/**/*.{ts,tsx,mts}",
    instructions:
      "Hold mobile HMR, native module, and React Compiler changes to docs/internals/13_mobile-development.md.",
  },
  {
    files: "docs/internals/14_i18n.md",
    applyTo:
      "{apps/web/src,apps/mobile/src,apps/desktop/src,packages/client-runtime/src,packages/shared/src}/**/*.{ts,tsx}",
    instructions:
      "Hold user-facing copy and translations to the rules in docs/internals/14_i18n.md.",
  },
  {
    files: "docs/internals/15_testing.md",
    applyTo: "{apps,packages,infra}/**/*.{ts,tsx}",
    path: "**/*.test.*",
    instructions:
      "Hold changed tests to the rules in docs/internals/15_testing.md. Request tests only as those rules allow.",
  },
  {
    files: "docs/internals/16_performance-regressions.md",
    applyTo:
      "{apps/server/src/orchestration-v2,apps/server/integration,apps/mobile/src}/**/*.{ts,tsx}",
    instructions:
      "Hold wire payload, indexing, and mobile animation changes to docs/internals/16_performance-regressions.md.",
  },
  {
    files: "docs/internals/17_scripts.md",
    applyTo: "{scripts,apps/*/scripts,packages/*/scripts,infra/*/scripts}/**/*.{ts,mts}",
    instructions:
      "Hold repository and package scripts to docs/internals/17_scripts.md: use Effect, effect/cli, NodeServices, and NodeRuntime.runMain rather than raw node:fs, node:child_process, or hand-rolled process.argv parsing.",
  },
  {
    files: "AGENTS.md",
    applyTo: "docs/internals/**/*.md",
    instructions:
      "Hold internal doc edits to the Documentation rules in AGENTS.md: keep only durable architectural decisions, trust boundaries, conventions, and cross-cutting traps. Flag single-feature walkthroughs, field/method catalogs, exact constants/timeouts/migration numbers, and PR appends.",
  },
] as const;

export default defineConfig((ctx) => ({
  reviews: {
    high_level_summary: false,
    review_status: false,
    request_changes_workflow: isGated(ctx),
    allow_author_approval: !isGated(ctx),
    auto_review: {
      enabled: true,
    },
    pre_merge_checks: {
      docstrings: { mode: "off" },
      override_requested_reviewers_only: isGated(ctx),
      custom_checks: [
        {
          name: "Approvability",
          mode: isGated(ctx) ? "error" : "off",
          instructions: approvability,
        },
      ],
    },
    path_filters: ["!.repos/**"],
    path_instructions: DOC_RULES.map((rule) => ({
      path: "path" in rule ? rule.path : rule.applyTo,
      instructions: rule.instructions,
    })),
  },
  knowledge_base: {
    code_guidelines: {
      filePatterns: DOC_RULES.map(({ files, applyTo }) => ({ files, applyTo })),
    },
  },
}));
