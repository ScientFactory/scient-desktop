// FILE: migration035FrozenModelSelectionCompatibility.test.ts
// Purpose: Proves the frozen migration-035 snapshot is behaviorally identical to
//   the live modelSelectionCompatibility for old persisted data, and that its
//   hardcoded DROID_ONLY set still matches the live catalog derivation.
// Layer: Persistence migration test

import { MODEL_OPTIONS_BY_PROVIDER } from "@synara/contracts";
import { assert, it } from "@effect/vitest";

import {
  normalizeLegacyModelSelection as frozenNormalizeLegacy,
  normalizePersistedModelSelection as frozenNormalizePersisted,
} from "./migration035FrozenModelSelectionCompatibility.ts";
import {
  normalizeLegacyModelSelection as liveNormalizeLegacy,
  normalizePersistedModelSelection as liveNormalizePersisted,
} from "./modelSelectionCompatibility.ts";

// The one and only catalog-coupled behavior in the live helper: provider-less
// slugs that belong exclusively to the Droid provider are attributed to "droid".
// Reproduce the live derivation here from the current catalog so the assertion
// tracks the catalog rather than a stale literal.
const liveNonDroidSlugs = new Set(
  Object.entries(MODEL_OPTIONS_BY_PROVIDER).flatMap(([provider, models]) =>
    provider === "droid" ? [] : models.map((model) => model.slug.toLowerCase()),
  ),
);
const liveDroidOnlySlugs = MODEL_OPTIONS_BY_PROVIDER.droid
  .map((model) => model.slug.toLowerCase())
  .filter((slug) => !liveNonDroidSlugs.has(slug));

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

it("frozen normalizePersistedModelSelection matches the live helper across the corpus", () => {
  for (const input of persistedCorpus) {
    assert.deepEqual(
      frozenNormalizePersisted(input),
      liveNormalizePersisted(input),
      `mismatch for input ${JSON.stringify(input)}`,
    );
  }
});

it("frozen normalizeLegacyModelSelection matches the live helper for every Droid-only slug", () => {
  for (const slug of liveDroidOnlySlugs) {
    const input = { provider: undefined, model: slug, options: undefined };
    assert.deepEqual(
      frozenNormalizeLegacy(input),
      liveNormalizeLegacy(input),
      `mismatch for ${slug}`,
    );
  }
});

it("frozen DROID_ONLY set still equals the live catalog-derived Droid-only set", () => {
  // A provider-less slug is attributed to "droid" iff it is Droid-only. Assert the
  // frozen snapshot attributes exactly the live catalog's Droid-only slugs to droid.
  for (const slug of liveDroidOnlySlugs) {
    const result = frozenNormalizePersisted({ model: slug }) as { provider: string };
    assert.strictEqual(result.provider, "droid", `expected droid for Droid-only slug ${slug}`);
  }
  // And no non-droid catalog slug is mis-attributed to droid by the frozen snapshot.
  for (const slug of liveNonDroidSlugs) {
    const result = frozenNormalizePersisted({ model: slug }) as { provider: string };
    assert.notStrictEqual(result.provider, "droid", `Droid inference stole non-droid slug ${slug}`);
  }
});

it("does not attribute the newly added Claude Opus 5 slug to Droid", () => {
  assert.deepEqual(frozenNormalizePersisted({ model: "claude-opus-5" }), {
    provider: "claudeAgent",
    model: "claude-opus-5",
  });
});
