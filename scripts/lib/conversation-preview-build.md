# Native conversation-preview artifact gate

Native previews are off by default. Set `SCIC_PREVIEW_ENABLE_NATIVE=1` and
`SCIC_PREVIEW_QUALIFIED_STAGE_MANIFEST` to a JSON file to stage one. The manifest
has `schemaVersion: 2`, `status`, `platform` (`mac` or `win`), `arch`, `channel`,
`sourceSha256`, `dependencyRevision`, and a nonempty human `evidence` reference.
The builder checks exact target fields and hashes the native source, build
scripts, and native CI workflow; Windows also requires the clean CI-pinned
vcpkg revision and a `libarchive@3.8.7/policy1` dependency revision. macOS
qualification requires `json-c@0.19/libarchive@3.8.7/policy1`; the hashed
build script links the patched static archive from the pinned source.

On Windows, set `VCPKG_ROOT` to a checkout at revision
`9e593bb18ea69cc5095e012465dcd675a822ed0d` and pass a fresh, empty
`BuildDirectory` to `scripts/build-conversation-preview.ps1`. The script checks
the checkout, bootstraps vcpkg, and installs `zlib` and `json-c` with
their transitive dependencies into `BuildDirectory/vcpkg-installed`. CMake
fetches the pinned, patched libarchive 3.8.7 source into
`BuildDirectory/_deps/scic_libarchive-src`; the Windows build rejects a
libarchive library resolved outside the source build and checks CMake resolved
zlib/json-c from the isolated vcpkg install. The script clears
inherited vcpkg/CMake package inputs, disables binary caching, and gives CMake
that same install root for both the DLL and CLI. Packaging uses a fresh build
directory and copies zlib/json-c notices from its actual isolated install and
libarchive's `COPYING` from the fetched source. Existing
`VCPKG_ROOT/installed` packages and notices are never used. The dependency
install and source fetch need network access; they are intentionally separate
from the lightweight TypeScript tests.

`status: "candidate"` is accepted **only** for a desktop `-pr.` preview-version
artifact. It permits building an installed candidate for Finder/Explorer QA; it
does not assert qualification and must not be published as a release. Stable
and nightly builds require `status: "qualified"` for that exact source and
target. Native CI compilation alone does not issue qualification: record the
installed, signed-platform evidence separately before marking a manifest
qualified. The macOS extension gets a channel-specific bundle ID under the
unchanged parent app ID; the shared `.scic` UTI stays stable.
