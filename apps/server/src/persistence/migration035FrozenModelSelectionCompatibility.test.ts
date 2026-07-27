// FILE: migration035FrozenModelSelectionCompatibility.test.ts
// Purpose: Proves the frozen migration-035 snapshot preserves its v0.5.13 golden
//   behavior without coupling the historical migration back to the live catalog.
// Layer: Persistence migration test

import { assert, it } from "@effect/vitest";

import {
  normalizeLegacyModelSelection as frozenNormalizeLegacy,
  normalizePersistedModelSelection as frozenNormalizePersisted,
} from "./migration035FrozenModelSelectionCompatibility.ts";

// Persisted-shape corpus spanning every branch of normalizePersistedModelSelection,
// with emphasis on the ambiguous-provider and Droid-model cases.
const persistedCorpus: readonly unknown[] = [
  // Non-record / no-op inputs.
  null,
  undefined,
  "not-a-record",
  42,
  [],
  [{ id: "effort", value: "high" }],
  {},
  { provider: "codex" },
  { model: "   " },
  // Canonical selections.
  { provider: "pi", model: "openai/gpt-5.5" },
  { provider: "claudeAgent", model: "claude-opus-4-8" },
  { provider: "droid", model: "minimax-m3" },
  // Provider-less ambiguous slugs (must NOT be stolen by droid inference).
  { model: "claude-opus-4-8" },
  { model: "claude-opus-5" },
  { model: "claude-sonnet-4-6" },
  { model: "gemini-3.5-pro" },
  { model: "grok-4" },
  { model: "gpt-5.5" },
  { model: "some-unknown-model" },
  // Instance-label inference.
  { instanceId: "Antigravity CLI", model: "Claude Sonnet 4.6 (Thinking)" },
  { instanceId: "Antigravity Claude runtime", model: "Claude Sonnet 4.6 (Thinking)" },
  { instanceId: "local-pi-runtime-instance", model: "openai/gpt-5.5" },
  { instanceId: "Factory Droid", model: "gpt-5.5" },
  { instanceId: "cursor-instance", model: "claude-opus-4-8" },
  { instanceId: "opencode runner", model: "claude-opus-4-8" },
  { instanceId: "kilo-worker", model: "claude-opus-4-8" },
  // Legacy Gemini migration + antigravity combined labels.
  { provider: "gemini", model: "gemini-3.1-pro-preview" },
  { provider: "gemini", model: "gemini-3-flash-preview" },
  { provider: "gemini", model: "gemini-custom-preview" },
  { provider: "antigravity", model: "Gemini 3.5 Flash (High)" },
  { provider: "antigravity", model: "Gemini 3.5 Flash (bogus)" },
  // Legacy option-row arrays and provider-scoped options.
  { provider: "codex", model: "gpt-5.5", options: [{ id: "effort", value: "high" }] },
  {
    provider: "claudeAgent",
    model: "claude-opus-4-8",
    options: { claudeAgent: [{ id: "fastMode", value: true }] },
  },
  { provider: "antigravity", model: "Gemini 3.5 Flash (High)", options: [{ id: "x", value: 1 }] },
];

const persistedGoldenOutputs: readonly unknown[] = [
  null,
  undefined,
  "not-a-record",
  42,
  [],
  [{ id: "effort", value: "high" }],
  {},
  { provider: "codex" },
  { model: "   " },
  { provider: "pi", model: "openai/gpt-5.5" },
  { provider: "claudeAgent", model: "claude-opus-4-8" },
  { provider: "droid", model: "minimax-m3" },
  { provider: "claudeAgent", model: "claude-opus-4-8" },
  { provider: "claudeAgent", model: "claude-opus-5" },
  { provider: "claudeAgent", model: "claude-sonnet-4-6" },
  { provider: "antigravity", model: "gemini-3.5-pro" },
  { provider: "grok", model: "grok-4" },
  { provider: "codex", model: "gpt-5.5" },
  { provider: "codex", model: "some-unknown-model" },
  {
    provider: "antigravity",
    model: "Claude Sonnet 4.6",
    options: { reasoningEffort: "thinking" },
  },
  {
    provider: "antigravity",
    model: "Claude Sonnet 4.6",
    options: { reasoningEffort: "thinking" },
  },
  { provider: "pi", model: "openai/gpt-5.5" },
  { provider: "droid", model: "gpt-5.5" },
  { provider: "cursor", model: "claude-opus-4-8" },
  { provider: "opencode", model: "claude-opus-4-8" },
  { provider: "kilo", model: "claude-opus-4-8" },
  { provider: "antigravity", model: "Gemini 3.1 Pro" },
  { provider: "antigravity", model: "Gemini 3.5 Flash" },
  { provider: "antigravity", model: "gemini-custom-preview" },
  {
    provider: "antigravity",
    model: "Gemini 3.5 Flash",
    options: { reasoningEffort: "high" },
  },
  { provider: "antigravity", model: "Gemini 3.5 Flash (bogus)" },
  { provider: "codex", model: "gpt-5.5", options: { effort: "high" } },
  {
    provider: "claudeAgent",
    model: "claude-opus-4-8",
    options: { fastMode: true },
  },
  {
    provider: "antigravity",
    model: "Gemini 3.5 Flash",
    options: { x: 1, reasoningEffort: "high" },
  },
];

const frozenDroidOnlySlugs = [
  "claude-opus-4-8-fast",
  "claude-opus-4-7-fast",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
  "gpt-5.5-fast",
  "gpt-5.5-pro",
  "gpt-5.4-fast",
  "gpt-5.3-codex-fast",
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "glm-5.2",
  "glm-5.2-fast",
  "glm-5.1",
  "nemotron-3-ultra",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "deepseek-v4-pro",
  "minimax-m3",
  "minimax-m2.7",
] as const;

it("preserves the frozen v0.5.13 persisted-selection golden corpus", () => {
  assert.strictEqual(persistedCorpus.length, persistedGoldenOutputs.length);
  for (const [index, input] of persistedCorpus.entries()) {
    assert.deepEqual(
      frozenNormalizePersisted(input),
      persistedGoldenOutputs[index],
      `v0.5.13 mismatch for input ${JSON.stringify(input)}`,
    );
  }
});

it("preserves the frozen v0.5.13 Droid-only slug set", () => {
  for (const slug of frozenDroidOnlySlugs) {
    const input = { provider: undefined, model: slug, options: undefined };
    assert.deepEqual(frozenNormalizeLegacy(input), { provider: "droid", model: slug });
  }
  for (const slug of ["claude-opus-4-8", "gpt-5.5", "gemini-3.5-pro", "grok-4"]) {
    const result = frozenNormalizePersisted({ model: slug }) as { provider: string };
    assert.notStrictEqual(result.provider, "droid", `frozen Droid inference stole ${slug}`);
  }
});

it("does not attribute the newly added Claude Opus 5 slug to Droid", () => {
  assert.deepEqual(frozenNormalizePersisted({ model: "claude-opus-5" }), {
    provider: "claudeAgent",
    model: "claude-opus-5",
  });
});
