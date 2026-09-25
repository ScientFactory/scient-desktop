# Model manifest

The [bundled manifest](../../apps/server/src/provider/model-manifest.json) allows
offline startup; fetching it from `main` lets model metadata change between
releases. Failed fetches or invalid data preserve the last usable manifest.
Remote data must pass both catalog-reference validation and the owning provider's
adapter validation before replacing the cache.

A newer bundle outranks the cached remote manifest by `updatedAt`, so a release can
correct model data before the next successful fetch. Bump `updatedAt` whenever the
file changes. Fetch time cannot establish which copy contains the newer edit.

Generic catalog data describes presentation and capabilities. Each provider owns
its adapter schema and dispatch mappings. Claude uses the manifest for its entire
built-in catalog. Adding a model with an existing capability profile is a JSON
edit; a new profile is needed only for a new capability combination. Codex still
gets its model list from its app server.

`currentModels.claudeAgent` is the current-model classification overlay for
releases that predate catalog discovery; it does not add models to their catalogs.
Catalog-aware releases use `providers.claudeAgent.models[].status` instead.
For newer clients, manifest model statuses are explicit: a catalog entry marked
`legacy` places that discovered model under **Legacy models**, and an entry
marked `current` clears a stale provider legacy flag. An unclassified discovered
model remains visible by default (and preserves any legacy status supplied by
its provider). This keeps new Codex and Antigravity discoveries from being
hidden just because the catalog predates them. Known older Codex IDs and
Antigravity model families stay in the manifest as explicit legacy entries;
Antigravity Low/Medium/High variants inherit their base family's status. The
top-level `currentModels` lists remain as positive current classifications for
newer clients and as a compatibility fallback for releases that predate
explicit status handling.

Claude is different: its built-in catalog is manifest-owned, so new Claude
models need a catalog entry before the provider can present them. Droid's
**More models** grouping is a separate provider-specific curation policy.

Model data is schema-validated configuration. Tests should cover resolver, cache,
and adapter semantics with synthetic model names, so adding a model never requires
tests that repeat the configuration.
