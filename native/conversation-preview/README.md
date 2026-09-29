# Native `.scic` preview integration

This directory contains a shared read-only preview parser, a macOS data-based
Quick Look extension and a Windows `IPreviewHandler` DLL. Linux uses the local
Scient read-only preview window. The parser uses libarchive for ZIP and json-c for JSON. It never
extracts an entry to disk or evaluates Markdown/HTML; every platform displays
plain text from `conversation.json` (title, role, message text). The CLI is
also a fixture-friendly smoke surface.

All platforms build the same SHA-256-pinned libarchive source with
`cmake/PatchArchive.cmake`. Its preview-only ZIP policy checks the full 16-bit
local-header compression method before extra fields or symlink decoding:
only stored/deflate are accepted, and the first entry must be stored at offset
zero. A required policy-version symbol makes linking an unpatched system
library fail. This check cannot safely live only after `next_header`, because
libarchive may decompress symlink targets inside that call. Optional codecs
are also disabled. Normal stored/deflated members and streamed data descriptors
remain supported; no archive contents are extracted to disk.

## Build and host contract

- macOS: `scripts/build-conversation-preview.sh` requires Xcode, CMake, and
  HTTPS access to pinned upstream source archives. It verifies SHA-256, builds
  static json-c 0.19 in the isolated build directory for the requested
  architecture and deployment target, and builds the pinned preview-only
  libarchive described below. Only zlib comes from the macOS SDK.
  It does not use Homebrew libraries or install dependencies globally. Set
  `SCIC_PREVIEW_BUILD_DIR` to an exact fresh directory and
  `SCIC_PREVIEW_MAC_ARCH` to `arm64`, `x86_64`, or `universal` (default: host
  architecture). The bundle is at
  `buildDir/macos-VARIANT/xcode/Release/ScientConversationQuickLook.appex` and
  the diagnostic CLI at `buildDir/macos-VARIANT/native-build/scic-preview`.
  `SCIC_PREVIEW_MACOS_MIN` defaults to `12.0` and rejects older versions.
  `SCIC_PREVIEW_BUNDLE_ID` overrides the standalone bundle identifier for the
  parent app's channel; the build checks the resulting Info.plist value.
  The pinned archives are upstream json-c `0.19-nodoc`
  (`704927172443309a8efeb162060bb215548e1286e5568514007dd2cc35a0a164`)
  and libarchive `3.8.7` source
  (`4b787cca6697a95c7725e45293c973c208cbdc71ae2279f30ef09f52472b9166`).
  The packaging owner embeds this bundle at
  `Scient.app/Contents/PlugIns/ScientConversationQuickLook.appex`, then signs
  the nested extension with the parent app's team before signing the app.
  The extension and its executable use the dedicated Xcode entitlement file:
  App Sandbox and user-selected read-only file access only, without network,
  JIT, or inherited Electron permissions. The macOS signer verifies the signed
  capabilities on both extension paths before accepting the app; only matching
  team/bundle identity metadata and a false debug-attach flag may accompany
  those two required entitlements.
  The supported UTI must be the parent app's exported
  `com.scientfactory.scient.conversation`. Build output is uninstalled and
  unsigned. Local C++/Swift compilation does not establish Finder activation
  or runtime compatibility on the oldest supported macOS release; both need
  installed, signed-candidate QA.
- Windows: point `VCPKG_ROOT` at the pinned clean toolchain, then run
  `scripts/build-conversation-preview.ps1` with
  `-Triplet x64-windows-static` or `-Triplet arm64-windows-static`. The script
  installs zlib and json-c into a fresh isolated directory with binary caching
  disabled, builds the pinned patched libarchive from source, selects the
  matching Visual Studio architecture and static MSVC runtime,
  builds the DLL, CLI, and an unregistered COM smoke executable, then runs
  the smoke via CTest on x64. ARM64 CI compiles but does not execute the ARM64
  test on an x64 host. The installer
  places `ScientConversationPreview.dll` outside `app.asar` and registers CLSID
  `{E0C925A3-E41D-4969-B093-4B6B16028463}` as an in-process COM server
  (`ThreadingModel=Apartment`, `AppID={6D2B5079-2F0B-48DD-AB7F-97CEC514D30B}`
  for 64-bit `Prevhost.exe`), under the `.scic` ProgID's
  `shellex\{8895b1c6-b41f-4c1c-a562-0d564250836f}` key, and in
  `Software\Microsoft\Windows\CurrentVersion\PreviewHandlers`. The handler
  uses `IInitializeWithStream` and consumes only Explorer's supplied stream.
  Pass the channel's exact GUID as `SCIC_PREVIEW_CLSID` when building; the
  default above is only for standalone diagnostics. The release helper must
  pass the same GUID to its installer registration and verify it is embedded
  in the DLL. Registration and unregistration belong to the installer; this
  build does neither. The diagnostic `Release/scic-preview.exe` accepts a
  `.scic` path and runs the same parser; run `tests/test_preview.py` with that
  executable. Windows SDK compilation, Explorer launch, low-integrity behavior,
  and uninstall cleanup require Windows CI and installed-candidate QA.
- Linux: the same shell build produces `scic-preview` for diagnostics. The
  primary desktop `.scic` association opens Scient's normal local conversation
  review, including its **Continue to import** action. An additional desktop
  **Preview** action invokes `Scient --preview-conversation file.scic` for the
  read-only window. The package must not associate the CLI with desktop open
  actions or launch a terminal text viewer. GNOME/KDE preview panes do not
  share a portable handler API; the local read-only window is the fallback.

The build script writes directly below the supplied `SCIC_PREVIEW_BUILD_DIR`;
it does not create a `run.*` child or a symlink. The packaging caller should
create a fresh build directory itself, pass its exact path, and consume the
paths above. The desktop artifact builder is owned separately. Its
native-preview branch
must be opt-in until platform qualification passes. For macOS, run the build
script before electron-builder, pass the resulting `.appex` as an `extraFiles`
directory to `PlugIns/ScientConversationQuickLook.appex` inside the app bundle,
sign the extension with the app's signing identity before sealing/signing the
outer app, and verify the nested signature and Finder Quick Look on an
installed candidate. Include the two license files in the shipped extension
(the Xcode project already copies them). For Windows, stage the DLL outside
ASAR, register the CLSID and preview-handler keys during installation, remove
those exact keys during uninstallation, and smoke-test Explorer preview in a
signed installed candidate. The Windows branch must remain disabled until
it compiles with the Windows SDK and passes this QA. Linux packages should
route their primary `.scic` association to the normal local review and add
a separate Preview action using `Scient --preview-conversation file.scic`;
the native CLI is diagnostic only.

The parser caps the source file at 768 MiB, declared expansion at 720 MiB,
entries at 10,000, manifest at 16 MiB, and the snapshot at 16 MiB. It reads
only `mimetype`, `manifest.json`, and `conversation.json`; attachments and
Markdown remain inert. Output is capped at 256 KiB / 200 messages / 4 KiB per
message. It verifies the snapshot bytes against the manifest SHA-256, but the
manifest is unsigned and this is not authenticity. The preview states that
the source is untrusted and marks shortened text. This is a display-only
subset of the import validator; it intentionally does not
verify attachment hashes or materialize an import. An otherwise valid larger
snapshot may show a preview-unavailable message while remaining importable.
Explicit Unicode direction embeddings and overrides (U+202A–U+202E) appear as
visible `[U+202E]`-style markers in titles and messages. Normal Hebrew/Arabic,
direction marks and isolates are preserved. This changes only preview output,
never the archive or its verified source bytes; markers count toward output limits.
The parser checks a five-second monotonic deadline between reads and entries;
an individual OS stream read that blocks cannot be forcibly interrupted in
this implementation. Windows parsing runs on a bounded background worker with
COM stream marshaling, cancellation and stale-result protection; unload does
not wait for an outstanding read. An apartment-bound host stream can still
dispatch its own I/O back to the originating thread. Actual host stream and
cancellation behavior therefore remain part of installed Explorer QA.
