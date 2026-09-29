# Native conversation-preview artifact gate

Native previews are off by default. Set `SCIC_PREVIEW_ENABLE_NATIVE=1` and
`SCIC_PREVIEW_QUALIFIED_STAGE_MANIFEST` to a JSON file to stage one. The manifest
has `schemaVersion: 2`, `status`, `platform` (`mac` or `win`), `arch`, `channel`,
`sourceSha256`, `dependencyRevision`, and a nonempty human `evidence` reference.
The builder checks exact target fields and hashes the native source, build
scripts, and native CI workflow; Windows also requires the clean CI-pinned
vcpkg revision. macOS dependency versions are pinned in its hashed build script.

`status: "candidate"` is accepted **only** for a desktop `-pr.` preview-version
artifact. It permits building an installed candidate for Finder/Explorer QA; it
does not assert qualification and must not be published as a release. Stable
and nightly builds require `status: "qualified"` for that exact source and
target. Native CI compilation alone does not issue qualification: record the
installed, signed-platform evidence separately before marking a manifest
qualified. The macOS extension gets a channel-specific bundle ID under the
unchanged parent app ID; the shared `.scic` UTI stays stable.
