# Upstream sync through `f2d5fc91e3`

Date: 2026-08-19

## Provenance

- Scient parent: `6b892102c8452c8f97f0e18a33f50ff08aa0de59`
- Official T3 tip: `f2d5fc91e3030e5c3956fdadc13e1eaa25bcabe3`
- Previous official cursor: `c7e6d711d3f2982e54854258987509e8f69b31cd`
- Integrated range: `c7e6d711d3..f2d5fc91e3`
- Official commits: 30
- Official files changed: 98
- Merge commit: `fe877096f8059e6eb2b766dda65cfd9307d3af0e`
- Worktree:
  `/Users/yaacov/REPOs/ScientFactory-worktrees/scient-desktop-next-t3-sync-f2d5fc91e3-20260819`
- Branch: `agent/t3-sync-f2d5fc91e3-20260819`

The merge commit has the owned Scient parent first and the exact official T3
tip second. No official commit was replayed, rebased, squashed, or
cherry-picked. The range contains no `orchestration-v2` source. T3 pull
request #2829 and its local review refs remain outside this alignment because
they are not ancestors of official `upstream/main`.

## Official range received

1. `33a8b07dd3` rotates mobile snoozed and settled shelf chevrons.
2. `a4cc1367b0` shows every usage-breakdown period.
3. `3723722f74` removes a duplicate web lookup assertion.
4. `cebac353de` displays structured-input option descriptions on mobile.
5. `82b8a93802` prevents status-free progress from reviving idle tasks.
6. `1896f39a38` simplifies GitHub pull-request CLI error transformation.
7. `a87f691bd4` opens local environment ports through `localhost`.
8. `f3cb7f5095` prevents desktop quit-shortcut spillover.
9. `3b5d476eb6` preserves a custom packaged macOS dock icon.
10. `fda740ad7b` shows project locations in the new-thread picker.
11. `db0659fead` installs AUR launcher icons in theme search paths.
12. `26af903b9b` labels pull-request merge actions.
13. `636caf4c70` excludes pull requests inherited from default upstreams.
14. `6a687ee43b` prevents an immediate passkey dialog on sign-in.
15. `3a02c9cf1d` adds browser-tab mute and audible state.
16. `bcfd485869` improves the disconnected composer placeholder.
17. `fe281c5408` throttles hidden preview rendering.
18. `e7f6a30cab` makes Cursor, Grok, and OpenCode opt-in.
19. `efcf7d1ac0` lets the desktop renderer paint unthrottled during startup.
20. `f21b47e52d` prevents repeated settlement from one merged pull request.
21. `324ddda314` adds the coding-agent-assisted `t3 triage` command.
22. `5ea5a80a83` serves the Apple Silicon download to Safari.
23. `3b8e7bbbe0` adds keyboard shortcuts to the surface menu.
24. `67e2fe71d9` removes unreliable Intel-versus-Apple-Silicon browser probing.
25. `36f4314ab7` animates command-palette closing while retaining its mode.
26. `7441b36926` upgrades Clerk's desktop OAuth transport.
27. `2aa5f095fc` adds macOS launchd background-service support.
28. `8bbbab5051` aligns sidebar statuses with project names.
29. `24c4ba68f5` closes desktop windows before quit cleanup.
30. `f2d5fc91e3` stops automatic desktop passkey prompts.

## Conflict composition

| File                                                        | T3 behavior adopted                                                | Scient behavior retained                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `apps/desktop/src/app/DesktopLifecycle.test.ts`             | Shared lifecycle test helpers and window-destruction coverage.     | Scient application identity in the Electron fixture.                 |
| `apps/server/src/bin.ts`                                    | The `triage` command.                                              | D4 service-command exclusion and cloud-public-config gating.         |
| `apps/server/src/cli/connect.ts`                            | Platform-accurate launchd and systemd availability text.           | Scient product naming.                                               |
| `apps/server/src/cli/service.ts`                            | macOS launchd support and login-scoped wording.                    | Scient naming and fail-closed onboarding.                            |
| `apps/server/src/cloud/pinnedRuntime.ts`                    | Unit-or-launch-agent runtime documentation.                        | Scient release assets instead of `t3@<Scient version>`.              |
| `apps/web/src/components/ChatView.tsx`                      | Preview runtime tab IDs and timestamped change-request settlement. | Quick Chat capability denial and project-script scientific previews. |
| `apps/web/src/components/CommandPalette.tsx`                | Environment locations in project targets.                          | Projectless Quick Chat creation and aliases.                         |
| `apps/web/src/components/RightPanelTabs.tsx`                | Data-driven surface shortcuts and browser-tab mute actions.        | The Scient Sources surface and its `S` shortcut.                     |
| `apps/web/src/components/chat/ChatComposer.tsx`             | Shared disconnected-project placeholder.                           | Quick Chat's projectless prompt.                                     |
| `apps/web/src/components/chat/ChatHeader.tsx`               | Timestamped change-request type.                                   | Quick Chat identity and move-to-project action.                      |
| `apps/web/src/components/settings/ProviderInstanceCard.tsx` | Central provider-enabled resolution.                               | Scient environment-scoped provider lifecycle controls.               |

## Scient adaptations

### Projectless Quick Chat

The pull-request settlement migration now passes `{ state, updatedAt }` across
web and mobile while retaining every `projectId: null` branch. Quick Chat
continues to deny pull requests, Git, diffs, checkpoints, worktrees, setup
scripts, and revert authority while retaining files, PDFs, terminal, browser,
agents, Sources, relocation, and projectless fork behavior.

The command palette composes T3's environment-location descriptions with
Scient's environment-specific Quick Chat targets. The composer keeps “Ask
anything or attach images” for Quick Chat and uses T3's improved shared
placeholder only for project threads.

### Preview and scientific surfaces

Scient receives browser-tab audio state, mute controls, hidden-preview
throttling, and runtime-tab ownership checks. The composed right-panel action
model retains Sources with the `S` shortcut. Project-script auto-preview,
static scientific artifacts, PDF, LaTeX, generated images, Plotly, Vega-Lite,
attachments, and multi-edge panel behavior remain mounted through their
existing Scient seams.

### Provider policy

Cursor, Grok, and OpenCode are now opt-in and are not probed while disabled.
The upstream explicit-false-wins migration is composed with Scient's
environment-scoped provider connection and managed-runtime controls.

### D4 service and release envelope

The service and service-preflight commands remain absent while the compiled
D4 safety envelope is enabled. Service onboarding remains fail-closed even
when a selected-user cloud route is explicitly enabled.

The dormant generic service implementation now uses dedicated Scient service
identities, `scient.service` on systemd and
`com.scientfactory.scient.service` on launchd, rather than colliding with an
installed T3 service. The compatible `T3CODE_HOME` and
`T3_BOOT_SERVICE_UNIT` contracts remain unchanged.

T3's AUR source updates remain inert ancestry. This alignment does not enable
AUR, mobile, hosted-web, relay, npm, updater, signing, or release publication.

### Triage and identity

The compatible command remains `t3 triage`, but its product copy, source
clone, playbook refresh, and issue destination point to Scient. The passkey
characterization uses Scient's production protocol. User-facing background
service documentation uses Scient naming.

### BiDi and RTL

Scient content direction remains independent of T3's `parseRawHtml` switch.
The `ContentDirection` contract, automatic direction default, local-section
logic, direction-aware tooltip portal, and RTL presentation tests remain
unchanged.

## Validation

- focused merge tests: 384 passed
- protected Quick Chat, scientific preview, and BiDi tests: 111 passed
- focused service, identity, triage, and passkey tests: 23 passed
- `pnpm exec vp fmt --check`
- `pnpm exec vp lint --report-unused-disable-directives`
- `pnpm run typecheck`
- `pnpm run test`
- `pnpm run build`
- `pnpm run test:desktop-smoke`
- `pnpm brand:check`
- Quick Chat, analysis, and LaTeX seam verifiers
- upstream provenance verifier
- `git diff --check`

The full lint gate completed with the same 13 non-blocking warnings recorded
by the preceding alignment and no errors. The production build retained the
known bundle-size, dependency-bundle, direct-eval, and sourcemap warnings.

No browser automation, live-data access, publication, signing, or release
action was performed.
