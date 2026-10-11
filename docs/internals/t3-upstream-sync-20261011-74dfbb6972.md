# T3 upstream alignment — 2026-10-11

## Exact boundaries

- Owned stack base: `298c0c03053d71eeec72a37943196c877f3b326b`, the head of [Scient PR #498](https://github.com/ScientFactory/scient-desktop/pull/498).
- Owned main included by that base: `643ad4e15740a97cef29c978d2a73473069a894a`.
- Previous official boundary: `bd2346eda2e2c380d1844869c7fd16c279d2190f`.
- Official target: `74dfbb697235b0db87355d3f8575dc2ba45dddf7`; no exact tag at this commit.
- Range: all 54 official first-parent commits, including the two commits after the initial 52-commit review. No unmerged proposal or cherry-picked replacement substitutes for this range.
- Literal upstream merge: `274000eb4a28df36ba2af097075bf5c215641e7f`. Its first parent is the exact stack base; its second parent is the exact official target.
- Branch: `codex/t3-sync-74dfbb6972-stack-20261011`.
- Stacked publication: [Scient PR #513](https://github.com/ScientFactory/scient-desktop/pull/513), targeting PR #498's branch; auto-merge is disabled and neither PR is merged by this task.
- Qualified runtime source: `f67d1ca39a638110120b359ed9ecb4d68fdbdbbd`; tree `f83e3a6fe324556b06370d5956b30ddb05f25c96`.
- No additional owned-main catch-up in this layer. The parent alignment's owned-main ancestry and documented bounded callback-composition exception remain; this layer grants no broader exception.
- Upstream push URL remains `DISABLED`.

## Integrated behavior and Scient composition

The host-owned source-control migration is composed as one dependency group: open provider-kind slugs, host definitions, capability-driven clone/publication/PR actions, settings and secrets. GitCafe retains its existing HTTPS clone default. GitHub, GitLab, Forgejo, GitCafe, Bitbucket and Azure DevOps retain their distinct capabilities; no unsupported universal publication claim is added.

Claude gains native child Stop, truthful child models/effort, settled orphan lifecycle, Claude 5 task-list delivery and wrapped gateway auto-resume. Its scoped MCP registration uses stdin, not credential-bearing process arguments or inherited auth environment. Scient's native lifecycle, permission, frozen history, fork and instruction ownership remain.

Pi gains image/structured tool outcomes, truthful abort/exit state, thinking defaults, cancellable/expiring approvals and native-session usage. Production and direct/replay test construction share the existing Scient application composition. Provider-package internals remain generic. Stop is distinct from administrative close; native work is qualified against its accepted run, attempt, provider thread and session before physical actions.

OpenCode preserves thread naming, Zen/Go model identity, joined child completion and acknowledgement semantics. Queue/history work preserves executing queued intent, bounded snapshots, retained answers, inert inherited authority and reader position. The client thread-cache schema advances independently of native/provider persistence.

Web/desktop receives real attachment metadata, credential-free bounded HTML-preview image copying, Find/details coexistence, persistent per-thread maximization, path-paste underscore retention, mounting/cache changes and compact touch targets. Existing Scient scientific rendering, Sources, Skills, Compute, document/LaTeX workspace, onboarding, stacked-folder selector and managed/system provider policies remain.

Authorization changes keep settings mutations and preview input/uploads under their own scopes and reject insufficient full-access MCP grants. Project-scoped list queries, fair terminal persistence, PR-check precedence, settlement errors and worktree-base preflight are integrated without activating new publication authority.

## Semantic regressions found and repaired

These are composition repairs, not omissions from the official merge:

1. Project rename called the write method after a clean merge: retained the actual rename operation and consumer-visible filesystem semantics.
2. Metadata canonicalization changed literal POSIX filenames: preserve spaces, literal backslashes/colons, ordered duplicates and both home-relative spellings. Bound the actual filesystem/sniff path and avoid blocking on FIFOs.
3. Failed legacy-secret migration/cleanup could lose retry state during later settings replacement: retain retryable state and current-host precedence across partial removal and subsequent rewrites.
4. GitCafe's clone default drifted to SSH: preserve its supported HTTPS default through host-owned definitions.
5. New secret-migration dependencies were absent from ACP/Scient publication guards: update the real publication closure, not an exception or disabled guard.
6. Client metadata skipped backslash-home paths: route both spellings through the canonical metadata request; retain literal POSIX identity elsewhere.
7. Released native Stop left children or descendants active: settle only the captured owned native subtree, including active descendants behind settled parents and resumed coordinator ownership, without touching replacements, frozen history or unrelated roots.
8. Extended native Pi usage still wrote an old cache: write v6, import older v5/v4 read-only, retain current-cache precedence and exact deduplication.
9. Stale native consumer tests bypassed Scient Pi composition or checked the wrong prefill/session owner: migrate callers to the existing factory and preserve meaningful permission, question, lease, provenance, settlement and acknowledgement coverage. Remove obsolete wording, error-text and implementation assertions rather than repinning them.

No formatting/lint suppression, new compatibility alias, fake production fallback, telemetry, hosted deployment, signing, updater, mobile release or credential-policy activation was added.

## Exact local qualification

The complete final runtime gate finished at 2026-10-11T03:33:47Z, before the isolated review app was launched:

| Gate                            | Observed result                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Full root workspace tests       | Passed; 47 tasks, zero cache hits                                                                                    |
| Web                             | 957 files, 11,809 tests passed                                                                                       |
| Server                          | 913 files, 11,439 tests passed; 40 files and 128 tests skipped under existing optional/native/account/platform gates |
| Full workspace typecheck        | Passed                                                                                                               |
| Formatting                      | Passed, 8,366 files                                                                                                  |
| Lint                            | Completed without errors; existing React/plugin warnings remain, unsuppressed                                        |
| Wire performance                | 18 files, 387 tests passed                                                                                           |
| Seven real native stress suites | 7 files, 27 tests passed                                                                                             |
| Production build                | All six tasks passed, zero cache hits                                                                                |
| Hidden isolated Electron smoke  | Passed; no live profile copied                                                                                       |
| Brand audit                     | Passed, 3,150 product-surface files                                                                                  |
| All five Scient seam audits     | Passed against exact stack base and official target                                                                  |
| Provenance                      | Passed before ledger advancement; final ledger is separately rechecked at publication                                |

Native stress exercised 2,500 forks in 45,080.58 ms. A 50,041-item source produced options/fork/open observations of 303.40/436.27/56.11 ms, with 7,508 rows and bounded reads. These are local arm64 macOS observations, not a cross-platform benchmark. Raw inherited history rows remained absent from the bounded payload.

Production metadata smoke checked all 15,360 requested paths (240 batches, 64 paths each, concurrency 8): literal identity, home prefixes, ordering, duplicates, extensionless PNG sniffing, missing/null handling, nonblocking FIFO behavior and the 64/65 boundary. Exact responses passed; observed p95 was 2.08 ms.

Real hidden Electron decoding checked 28 diagram-theme cases, SVG PNG export/copy, saved SVG, 24 concurrent SVGs, PNG/JPEG, a 4,096×4,096 bound and iframe SVG/AVIF/GIF exact dimensions and pixels. Oversized SVG was rejected; external SVG requests were zero. Only the final clipboard write was intercepted: no system clipboard was read or modified.

The final repaired Pi/native consumer lane passed 533 tests across 28 files, full typecheck and formatting. A real Pi RPC subprocess received the complete 7,112-byte Scient instruction string through a scoped synthetic MCP registration and loopback synthetic model endpoint; no authenticated model or remote provider request was used.

Independent final source reviews of native resume/Stop ownership, private-command security, Pi composition, provider consumers, persistence, non-native composition and client/desktop composition returned no unresolved findings. Earlier failed/interrupted qualification attempts remain distinct evidence and are not counted as successful runs.

## Final visual and interaction review

Only after implementation, source review, tests, stress and build passed, launch an owned candidate from the exact qualified worktree. Review used a new synthetic HOME and state root; no live profile, credentials, user project or model output was copied.

Observed on the actual native Electron renderer and its shared backend:

- Two canonical synthetic imports (126 and 24 messages), honest import omissions and settled shelf navigation.
- Actual bounded-history paging; rendered geometry retains chronological synthetic input order despite recycled DOM order.
- Inline/display mathematics, English/Hebrew/Arabic, tables, Mermaid, Vega-Lite and Plotly in light/dark desktop views.
- Find/details coexistence and matching highlights in the real reader.
- Literal POSIX filename with space, backslash and colon opens the exact fixture.
- POSIX-home link and inline backslash-home file chip both open the isolated home fixture, with truthful outside-project read-only status. A client href fallback pointing at the ordinary home was not evidence of native resolution; activation and process HOME proved isolation.
- An external edit of an already-open synthetic Markdown file appears live without reload.
- Maximized file panel survives a cached-thread switch and return; interaction recording retained.
- Native Usage renders one synthetic Pi session, 3.20K processed tokens and a $0.06 estimate with its synthetic model breakdown. This is not authenticated billing verification.
- Native Sources empty library, Skills catalog, Scientific Computing settings and host-owned Source Control settings render correctly. No source, skill, runtime or credential settings were mutated.
- Actual LaTeX source opens in the editor; native auto-build completes and the real one-page PDF renders in Split and maximized Split mode.

A 390px exploratory web check observed the imported-provenance badge crowding header controls. The badge, header and button source are unchanged from the stack base; narrow-width visual acceptance is **not** claimed. Desktop visual/interaction review is the qualified surface. No native iOS/Android, Windows/Linux runtime, live authenticated Claude/Codex model, microphone, hosted publication or real system-clipboard qualification is claimed.

Screenshots: [native scientific reader](assets/t3-sync-20261011/native-scientific-reader.webp), [LaTeX Split/PDF](assets/t3-sync-20261011/native-latex-split.webp), [Sources](assets/t3-sync-20261011/native-sources.webp), [Skills](assets/t3-sync-20261011/native-skills.webp), [Compute settings](assets/t3-sync-20261011/native-compute-settings.webp), [Source Control](assets/t3-sync-20261011/native-source-control.webp), [synthetic Usage](assets/t3-sync-20261011/native-usage.webp), [390px limit](assets/t3-sync-20261011/web-390-existing-header-limit.png). [Panel/cache interaction recording](assets/t3-sync-20261011/panel-cache-interaction.mp4).

## Evidence reuse and publication boundary

Runtime evidence is pinned to `f67d1ca39a638110120b359ed9ecb4d68fdbdbbd`. Subsequent changes publish this receipt, visual assets and the integration pointers only; unchanged runtime tests/builds are reused under protocol §5.3. Hosted CI qualifies the exact pushed final revision separately. Existing optional-native/account skips and optional x11/Effect CJS build warnings are not converted into passing platform claims.

The new layer is stacked on PR #498's branch. The parent PR is not mutated. Open the new PR ready for review after final metadata/provenance checks, keep auto-merge disabled, and do not merge, release, publish or clean its worktree. The isolated native candidate remains open for the user's review and approval. User visual approval is separate from this agent's visual review.

## Complete official commit inventory

| Official commit                                                                                     | Advancement                                                                                           |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`c77a7b7eeb`](https://github.com/pingdotgg/t3code/commit/c77a7b7eebd6ea8a3a63bbcaaa7c1707fe65c86e) | fix(web): align compact button touch targets (#17748)                                                 |
| [`6266af3f1f`](https://github.com/pingdotgg/t3code/commit/6266af3f1f688497ef9717b87b82eafc5240418c) | fix(server): t3_thread_launch refuses a new worktree whose base ref has no commit (#17791)            |
| [`d6f3af7719`](https://github.com/pingdotgg/t3code/commit/d6f3af77192adfb2304769096eeec59d3464aa21) | fix(web): omit underlines on markdown image links (#17728)                                            |
| [`4606f9d6f2`](https://github.com/pingdotgg/t3code/commit/4606f9d6f213952124d93792854b0c4e48658e60) | fix(server): restore auto resume for wrapped Claude gateway rate limits (#17778)                      |
| [`e1ad595e0f`](https://github.com/pingdotgg/t3code/commit/e1ad595e0f10cc16d66fe54b4ee195435dd3cc0d) | fix(opencode): name OpenCode 2 sessions after their thread (#17414)                                   |
| [`472ea7ec5f`](https://github.com/pingdotgg/t3code/commit/472ea7ec5f67fae660dc606b82698d15a2bc850f) | fix(web): find update settings from the command palette (#17396)                                      |
| [`7b09ac7e00`](https://github.com/pingdotgg/t3code/commit/7b09ac7e0022769425471fad1c0d152c03d5954f) | fix(provider-opencode): tell OpenCode Zen and Go models apart (#17424)                                |
| [`adbecdac7b`](https://github.com/pingdotgg/t3code/commit/adbecdac7b6f1a167cc389b3d5fe5be8ec70afdf) | fix(server): a pull that fast-forwards no longer fails on large Git output (#17376)                   |
| [`91474e56f6`](https://github.com/pingdotgg/t3code/commit/91474e56f66888c5ab3856a782a72613e758c401) | fix(web): cancel question auto-advance after navigation (#17364)                                      |
| [`33c1e36fd0`](https://github.com/pingdotgg/t3code/commit/33c1e36fd097fe4f8e4498db653ee97b17184791) | fix(server): a bare repository name resolves to the signed-in account again (#17379)                  |
| [`71f6f1db89`](https://github.com/pingdotgg/t3code/commit/71f6f1db89a50f0108663ebf1724cf3a1a4134ed) | fix(web): a maximized right panel stays maximized when you return to its thread (#17327)              |
| [`02612c2856`](https://github.com/pingdotgg/t3code/commit/02612c28564056ddb7ae6b06cedd31dafc235ffd) | fix(mobile): allow starting a task with only an image (#17409)                                        |
| [`a418075154`](https://github.com/pingdotgg/t3code/commit/a418075154d1d4f4263d5fa55804b9288f61d3dd) | fix(server): PR watch no longer reports passed while a second run of a check is still going (#17344)  |
| [`a5b482452d`](https://github.com/pingdotgg/t3code/commit/a5b482452dc8ca87625d5a80f83be0a9b56674de) | fix(server): say why a thread can't be settled (#17258)                                               |
| [`03b2105281`](https://github.com/pingdotgg/t3code/commit/03b210528160e68c8dbfc27f11f693085f92ab09) | fix(server): prevent busy terminals from starving history persistence (#17181)                        |
| [`de49d637d4`](https://github.com/pingdotgg/t3code/commit/de49d637d4b72b3e3306533e3777cb37e6a3f738) | feat(server): use macOS .icns app icons as project icons (#17149)                                     |
| [`a1dee8b2b3`](https://github.com/pingdotgg/t3code/commit/a1dee8b2b34ad949935b703b85efb16b6fd1b987) | fix(mobile): usage reset icon lines up with its row (#17175)                                          |
| [`ee7924ff7f`](https://github.com/pingdotgg/t3code/commit/ee7924ff7fcabe24d5e8d940ac5e878d36477a0d) | fix(web): paths pasted after @ keep their underscores (#16619)                                        |
| [`dd4549eede`](https://github.com/pingdotgg/t3code/commit/dd4549eede928f9dc514778aeae15d74656a87f8) | fix(server): settle every OpenCode subagent call one report answers (#17134)                          |
| [`8bf0a38873`](https://github.com/pingdotgg/t3code/commit/8bf0a38873aed486a585b2cebd8dd577ae5656b3) | perf(web): switching project keeps Diagnostics and Providers mounted (#17122)                         |
| [`f7664fdf42`](https://github.com/pingdotgg/t3code/commit/f7664fdf425555e0f85b74d904cfa4eaf57cf7af) | perf(web): Open Source Licenses downloads its manifest once per session (#17119)                      |
| [`94d1a8e93f`](https://github.com/pingdotgg/t3code/commit/94d1a8e93f0434d34fa894523a04fe6a6f6172f6) | fix(server): restore OpenCode adapter test typecheck (#17810)                                         |
| [`98beed1a22`](https://github.com/pingdotgg/t3code/commit/98beed1a226c42b85c52ff5ee9d5dbb67d776a77) | fix(server): Claude subagents show the reasoning effort they run at (#17496)                          |
| [`8c777fbfad`](https://github.com/pingdotgg/t3code/commit/8c777fbfade340f2092c011483c7fb0cde44c675) | feat(server): stop Claude subagents without stopping their owner (#17826)                             |
| [`afd98d7d18`](https://github.com/pingdotgg/t3code/commit/afd98d7d1840ed76f57d3ece556257aebc00f1bc) | fix(server): stopped native subagents no longer read as Running (#17223)                              |
| [`a11f464133`](https://github.com/pingdotgg/t3code/commit/a11f464133291122e0f6381b35e1b245d0aa9c73) | perf(server): t3_thread_list reads only the listed project's threads (#17843)                         |
| [`cfbd1457ad`](https://github.com/pingdotgg/t3code/commit/cfbd1457ad093b1cd7f6c53851009a62b676b203) | fix(server): show diffs for projects outside the server cwd (#17724)                                  |
| [`50647de014`](https://github.com/pingdotgg/t3code/commit/50647de0143e68fde051eb1a0ccf4fe63f9947b2) | fix(server): check the specific scope for scripts, preview input, and full-access MCP grants (#17772) |
| [`dacd2cb649`](https://github.com/pingdotgg/t3code/commit/dacd2cb649eea06a00244bd181eb400735e923d5) | fix(source-control): stop Forgejo status refresh from scanning every pull request (#12223)            |
| [`fd3549c8ff`](https://github.com/pingdotgg/t3code/commit/fd3549c8ffa5eac8230a8b5e1a87e59d28ba488e) | refactor(contracts): source control provider kind is an open branded slug (#17739)                    |
| [`7bc7328042`](https://github.com/pingdotgg/t3code/commit/7bc732804222946c0c9b23af057484e4412698fc) | feat(source-control): each host package ships a client definition (#17746)                            |
| [`c8a603307c`](https://github.com/pingdotgg/t3code/commit/c8a603307c2d50f8fb9d302f4b51f20fd9f91b33) | refactor(client-runtime): add project clone sources come from host definitions (#17756)               |
| [`579159d6c6`](https://github.com/pingdotgg/t3code/commit/579159d6c6e96f9c18358e492fbf0b8af740e80c) | refactor(web): host presentation and behavior come from client definitions (#17757)                   |
| [`b0249ac871`](https://github.com/pingdotgg/t3code/commit/b0249ac8711703f1a1b8cd0f3acd11155f5bf172) | refactor(source-control): reference parsing and project matching are host resolvers (#17770)          |
| [`9b40d37463`](https://github.com/pingdotgg/t3code/commit/9b40d3746388e573370488f73b50e1e869b79a45) | feat(pull-requests): quick actions follow each host's capabilities, not GitHub (#17774)               |
| [`a4c8745abe`](https://github.com/pingdotgg/t3code/commit/a4c8745abee3f73f960c914800974dee530dbc3b) | feat(projects): new projects can be published to any ready host (#17860)                              |
| [`f82796a16a`](https://github.com/pingdotgg/t3code/commit/f82796a16abb707c1e2c41301ad8d6e3153668c5) | fix(server): send Claude MCP servers over the control channel (#17898)                                |
| [`ec43786140`](https://github.com/pingdotgg/t3code/commit/ec4378614046ab58864ff5e640de2b46f6704505) | fix(web): a finished reply replaced by a steer is no longer labeled partial (#17761)                  |
| [`61eb4af69c`](https://github.com/pingdotgg/t3code/commit/61eb4af69c38c1f39e58ed76aa695b751f9f9baf) | fix(client-runtime): queued runs that start after a steer show up in the thread (#17764)              |
| [`2a4ee33982`](https://github.com/pingdotgg/t3code/commit/2a4ee339827e480da6ad0139585cf634a46ff73e) | feat(mobile): choose the microphone order for voice input (#17896)                                    |
| [`4f63275ac7`](https://github.com/pingdotgg/t3code/commit/4f63275ac7885281d245022e65f1e9e8816b1382) | feat(source-control): host settings live on each host's definition, with a GitCafe token (#17901)     |
| [`38c187bfb7`](https://github.com/pingdotgg/t3code/commit/38c187bfb7a0020db36ccc1479e7c3501b205fb8) | fix(pi): preserve tool images and structured results (#17851)                                         |
| [`a8bdfdb541`](https://github.com/pingdotgg/t3code/commit/a8bdfdb54181fb5c9d43f2747112c137a804d016) | fix(server): Claude 5 task lists reach the tasks drawer (#14964)                                      |
| [`f92afe79c9`](https://github.com/pingdotgg/t3code/commit/f92afe79c921dd7de20204e83d62fed0491b4e54) | fix(web): find bar and thread details panel stop covering each other (#17858)                         |
| [`0442f5bfcc`](https://github.com/pingdotgg/t3code/commit/0442f5bfcca6eca556ee79d41f4addb7a2022188) | fix(web): use server metadata for file chip icons (#17923)                                            |
| [`c8b89a01d7`](https://github.com/pingdotgg/t3code/commit/c8b89a01d70fd54cbc6b6a70ba0fdff702b821aa) | fix(desktop): copy images from HTML previews (#17555)                                                 |
| [`e408cac0d7`](https://github.com/pingdotgg/t3code/commit/e408cac0d7d903ccfcecfb906d4e48292294ab55) | docs(pi): update installation and remote login guidance (#17836)                                      |
| [`7e8071f1f1`](https://github.com/pingdotgg/t3code/commit/7e8071f1f1566220fb52cbfaaf97a2bc4e93a193) | fix(pi): preserve native abort outcomes (#17853)                                                      |
| [`160b18c866`](https://github.com/pingdotgg/t3code/commit/160b18c8667f8370f46708d273d368648316b200) | fix(pi): keep thinking defaults specific to each model (#17835)                                       |
| [`62da1cd48b`](https://github.com/pingdotgg/t3code/commit/62da1cd48bb43def11a79cd6aa033dbc478e4dfd) | fix(pi): preserve shell command exit codes (#17834)                                                   |
| [`6e9c5a851c`](https://github.com/pingdotgg/t3code/commit/6e9c5a851c92c52e2f4a8a80c655e60db133f9ac) | fix(pi): expire and cancel extension approvals (#17840)                                               |
| [`9afde1c6db`](https://github.com/pingdotgg/t3code/commit/9afde1c6dbe00d2b87829732c88789c10f3429c0) | feat(pi): include native sessions in usage reports (#17848)                                           |
| [`818e2be75e`](https://github.com/pingdotgg/t3code/commit/818e2be75e1a68bbcac122eac1b6fb815ccf4b73) | fix(server): route Copilot ACP subagent output into subagent threads (#17714)                         |
| [`74dfbb6972`](https://github.com/pingdotgg/t3code/commit/74dfbb697235b0db87355d3f8575dc2ba45dddf7) | fix(web): composer banner titles truncate beside their icon instead of wrapping (#17699)              |
