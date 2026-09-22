# Scient contextual keyboard ownership

Status: Active shared foundation. Visual editing integration remains adapter work.

## Ownership and settings

Shortcuts identify semantic actions, not file edits. The focused surface executes
an action through its existing transaction, selection, persistence, and history
owner. `apps/web/src/scient/keyboard/` owns the authoring command registry, portable
notation, validation, preference subscription, sequence state, and DOM focus claims.
It does not own document contents, TeX layout, Compute execution, or terminal input.

Application capture handlers consult pure claims along the composed event path
before acting. A claim does not execute or consume an event; the matching surface
does that once. Nested controls may reserve a chord for native handling without
mutating the outer document. Do not replace this with blanket suppression of all
application keys while a document is open. Dialog/recorder capture markers remain
separate. Terminal and preview focus come from their real event paths.

Application bindings retain their environment-owned contract and persistence.
Authoring overrides and math behavior use a versioned client-profile preference
under `scient.authoringKeyboard.v1`. Settings presents both in one Keybindings
location with explicit scope descriptions. No server schema, mobile setting, or
environment-authority migration is implied. OS-wide Capture settings remain in
their existing owner.

An absent override inherits the preset; an empty array disables a command; a
nonempty array replaces all defaults. Math and Markdown can overlap in focus and
are conflict-checked together; PDF read commands are disjoint. Exact and prefix
collisions are rejected. Application-condition conflicts use bounded boolean
overlap analysis and platform-resolved key aliases, not string equality or the
filtered table. Complex conditions conservatively warn.

Preferences are cached, subscribed across mounted editors, and refreshed on
cross-window storage events. Writes validate the whole object and reject stale
snapshot or persisted-data changes. Legacy math arrays migrate on read, preserve
the old key, and write the new format only on save. Invalid storage leaves the
default controls usable and shows an error. Import/export includes behavior
preferences as well as bindings; it does not export environment keybindings.

## Input and renderer boundaries

Sequences use one shared matcher for ownership and execution, with normalized
bindings cached by preference revision. Pending keys are announced, bounded by a
timeout, and cancelled on disposal, focus departure, or preference changes.
Invalid continuations are consumed; repeat does not repeat a structural command.
IME composition, dead keys, and AltGraph are not authoring shortcuts.

Markdown's ProseMirror adapter observes preferences without rebuilding the document
or resetting history. Its keymap and toolbar hints use effective bindings.
The math catalog/controller lives under `scient/math/input/`; source and Markdown
adapters supply guarded read/apply/focus operations. Math input into an equation
uses the owning ProseMirror history, not an independent textarea history.
Source context inference remains conservative lexical analysis, not a TeX parser.
In particular, real low-level macro definitions can disable automatic source
insertion; comments mentioning such commands do not.

PDF uses exact modifier matching and respects already-consumed events. Its
document zoom defaults are Alt+Up/Down/0; native Cmd/Ctrl zoom remains application
zoom. Browser/OS/native accelerators are outside the renderer resolver; a custom
binding to a reserved key is not guaranteed. Native edit/history primitives
cannot be reassigned as authoring actions.

## Integration contract for ongoing work

- Visual owns safe source ranges, semantic caret, compilation, and exact layout.
  Supply an adapter to the shared math controller; do not fork preferences,
  catalog, toolbar actions, or create a second undo stack.
- A Visual region registers only the commands it can safely handle. Unknown
  mappings remain unavailable; keyboard recognition is not permission to patch
  guessed source.
- Compute owns running/interrupting cells and execution state. Register its
  commands and focus conditions when those semantics stabilize; do not install
  competing global keydown listeners or reinterpret Enter here.
- Structural movement, clipboard, IME, accessibility, and native undo remain
  editor-owned. They are documented behavior, not hundreds of configurable
  application commands.

## Verification

Shared keyboard tests cover replacement/disable/reset, migration, stale writes,
platform aliases, context overlap, sequence expiry and invalid continuation,
composition, focus, and ownership disposal. Settings interaction tests exercise
actual recording/editing, conflict display, and stale drafts. Markdown, math,
source-adapter, and PDF regressions qualify the consumers separately. Native
menu interception and screen-reader behavior require platform interaction tests;
DOM-only evidence is not sufficient.
