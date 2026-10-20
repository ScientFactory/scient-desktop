The Enriched Markdown tarball comes from the [`fork/t3-mobile` branch](https://github.com/pingdotgg/enriched-markdown/tree/fork/t3-mobile). Its `t3-fork.json` records the exact source commit and upstream base. File/skill link recognition, back navigation from horizontal blocks, table-image presses, and code-block headers use upstream implementations. The remaining fork adds clipboard metadata, parsed asset manifests, signed image source resolution, React media slots, and development-host autolinks.

Scient keeps that tarball unchanged and applies
[`react-native-enriched-markdown@1.2.0-t3.11.patch`](../../../patches/react-native-enriched-markdown@1.2.0-t3.11.patch)
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

To replace it, commit the fork changes, run `yarn install --immutable` and `yarn workspace react-native-enriched-markdown prepare` in the fork checkout, then `node scripts/pack-t3.mjs /path/to/t3code/apps/mobile/deps`. Bump the fork package version for each replacement, update the tarball path in `apps/mobile/package.json` and `pnpm-workspace.yaml`'s `allowBuilds`, and run `vp i` to update the lockfile. Native clients need rebuilding when this dependency changes.
