# T3 upstream alignment through ddeb226831

Scient PR #1180 integrates the 237 official commits after `241d46c562`. The literal merge keeps both
histories.

## Git boundary

- The owned base is `c8efa33bd9daa2cc4d84cbd20bedea899f4446ea`.
- The previous official boundary is `241d46c562fa9a0e1bfc58de181a704dd43ac8f7`.
- The frozen official target is `ddeb226831a3cbca8d6d07f362e9c55f82b41eab`, no tag at the target
  (nearest reachable tag `v0.1.14-nightly.20261128.5385`).
- The range contains 237 official commits, 534 incoming paths, 268 same-path overlaps with Scient
  and 68 initially unmerged paths.
- The literal integration merge is `5f69412114443ec2f701ccab819c2a41ad3b46ab`, tree
  `16e2f3448076f3829e4f47b1a89bbb92f5cfd9c6`; parents are the owned base and the frozen official
  target.
- Branch `codex/t3-sync-ddeb226831-20261128`. The `upstream` push URL is `DISABLED`.

## User-visible changes

- Usage asks once per agent before reading its local history or sign-in, with a Usage access
  switch per provider. Scient Agent's own usage needs no grant and shows no switch.
- Thread details can show CPU, memory and disk, and an Agent tasks section. The sidebar warns
  when the machine is short on memory or disk or is overloaded, and agents can read the load.
- Images can be drawn on before sending. The composer can attach a folder. Markdown code blocks
  in replies preview rendered. Tables copy for chat apps. Markdown files offer Open preview.
- Threads can be snoozed indefinitely and pinned from the card. The local MCP URL can be copied
  from Sharing & access. Saved environments can be renamed. Polish is offered as a language.
- Many fixes to RTF, OpenDocument, EPUB, DOCX, PowerPoint, Excel and notebook previews and to the
  text agents receive from those files; provider fixes for Cursor (SDK 1.5.2), ACP, Antigravity
  and Codex; repository-link fixes across forges.

## Conflict resolution

- Usage access: T3's grant, reader filter and driver gates were adopted. Grok's gate was applied
  inside Scient's managed-runtime driver composition. Claude keeps Scient's provider-reported
  skill merge at startup because Settings → Skills lists global skills from that status; probes
  are cached per grant and a sign-in change drops both entries. Antigravity usage limits remain.
- Scient Agent usage comes from Scient's own state and bypasses the grant; its card has no switch.
- Claude startup phases: Scient keeps an exited CLI as the live query until cleanup ends, so the
  next turn's `launch` phase also counts a stream that already exited.
- Keybindings: Files keeps `mod+alt+e`; T3's maximize defaults to `mod+alt+shift+e`.
- Desktop spellcheck: Scient's `configureSpelling` stays the owner; T3's per-window seeding is
  skipped because it would re-add languages the user turned off.
- Thread links: T3's writer (angle-bracket destinations, hosted links for unsafe v2 ids) with
  Scient's v1 slash escape. Links saved with the old `%28`/`%29` encoding still resolve.
- Cursor: T3's team-policy retry sends MCP per turn under the `scient` server name, with
  Scient's disabled-MCP guard, grants and delivery receipt composed in.
- Command palette: a project opening is cancelled only when the page changes. A lost claim still
  moves a waiting draft into the added project but never opens a new thread.
- File panel: T3's Open preview waits for the open document's pending save. Scient's single
  "Save a copy to this device" covers T3's toolbar save. HTML refresh adds a revision only after a
  workspace refresh.
- Product copy introduced by T3 was rebranded; catalogs were regenerated and filled. The MCP tool
  list re-measured 184 bytes smaller, including T3's machine-load text.

## Review

Codex reviewed the merge against both parents. Taken: the late folder-add result could open a new
thread after the picker closed (fixed), and Usage help omitted the Scient Agent exception
(fixed). Not taken in this alignment:

- Cursor account limits and the queued-edit move to the stash behave as T3 ships them; Scient is
  no wider than upstream.
- Claude's startup skill scan is the source of Settings → Skills.
- The Polish relay-cap message translates a string Scient's relay never shows (brand allowlist).
- Scient's spellcheck locale normalization is a separate fix.

## Verification

Format, lint, Knip, type checking, brand, i18n and both diff checks passed with Node 26.13.1 and
pnpm 12.14.0 on arm64 macOS. All nine protected-area seam checks passed against the frozen
target. Focused suites for every changed test file in the touched packages passed locally
(shared, client-runtime, contracts, provider packages, desktop, web browser and unit files, and
the server files for usage, providers, Claude, ACP, Antigravity, MCP, orchestration and storage
cleanup). Hosted CI is the full gate.

The isolated macOS app ran the merge with a synthetic project and one real Codex turn: project
add, folder attach menu, image drawing, the Usage question and switches, MCP URL, Markdown
code-block preview, copy for chat apps, indefinite snooze, machine load in light and dark,
both panel shortcuts, rendered Markdown files and Polish. Windows and Linux are covered by hosted
CI only.
