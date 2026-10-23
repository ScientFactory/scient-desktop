The Enriched Markdown tarball comes from [`feat/t3chat-markdown-parity-v2`](https://github.com/pingdotgg/enriched-markdown/tree/feat/t3chat-markdown-parity-v2), based on Julius's [`fork/t3-mobile` branch](https://github.com/pingdotgg/enriched-markdown/tree/fork/t3-mobile). Its `t3-fork.json` records the exact source commit and upstream base. File/skill link recognition, back navigation from horizontal blocks, table-image presses, and code-block headers use upstream implementations. The fork retains clipboard metadata, parsed asset manifests, signed image source resolution, React media slots, and development-host autolinks. The fork retains native math parsing, scrolling and copying, table layout and gestures, and inline-code layout. Character-reference decoding, iOS intrinsic-width measurement, and HTML clipboard round trips now use the upstream fixes included in Julius's base. RaTeX uses the upstream-released 0.1.15 dependency.

The unchanged `react-native-screens-5.0.0-t3.30.tgz` archive comes from
[`juliusmarminge/react-native-screens`](https://github.com/juliusmarminge/react-native-screens)
commit `386fab20506da8759860fad5afa40cbd5a8b0f06`, with upstream base
`72f38a66c188bdebee7a7798c9b72a121b7a8451`, as recorded in its
`t3-fork.json`. Its SHA-256 is
`5aa52fbcc41adc7f4aa53b83d02558ad806a2f647701845b6238ba82b38d1a56`.
The archive retains Software Mansion's MIT license and copyright notice in
`package/LICENSE`. Updating the archive requires reinstalling the committed
lockfile and rebuilding both native clients; Metro refresh is insufficient.

Scient keeps that tarball unchanged and applies
[`react-native-enriched-markdown@1.2.0-t3.15.patch`](../../../patches/react-native-enriched-markdown@1.2.0-t3.15.patch)
through the committed pnpm patch mapping. The patch owns canonical text for
selected file links, occurrence-based matching before links become pills, and
context metadata limited to the selected references and their screenshot
dependencies. `src/native/ScientMarkdownProjection.ts` supplies the canonical
sources without rewriting stored messages. Its narrow mount in
`src/lib/markdownDocument.ts` reuses that utility's parser, HTML transform and
entity decoder. Native parser
handling retains encoded whitespace inside a parsed text span instead of
letting it introduce Markdown structure.

After changing this patch, reinstall from the committed lockfile and rebuild
the native client. CocoaPods must resolve the new patched package directory;
Metro refresh alone does not change native clipboard or parser behavior.

To replace it, commit the fork changes, run `yarn install --immutable` and `yarn workspace react-native-enriched-markdown prepare` in the fork checkout, then `node scripts/pack-t3.mjs /path/to/t3code/apps/mobile/deps`. Keep the package version aligned with Julius's `fork/t3-mobile` branch. Rename the archive to include the first eight characters of the source commit, such as `react-native-enriched-markdown-1.2.0-t3.15-fee84114.tgz`, so each build has a distinct dependency path without version bumps. Update the tarball path in `apps/mobile/package.json` and `pnpm-workspace.yaml`'s `allowBuilds`, and run `vp i` to update the lockfile. Native clients need rebuilding when this dependency changes.
