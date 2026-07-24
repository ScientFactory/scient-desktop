# Assistant artifact shelf collapse design QA

## Target

Long file shelves should show two complete cards and a subdued, non-interactive glimpse of the third. A single disclosure control reveals every remaining file and can collapse the shelf again.

## Evidence

- `collapsed-light.png` — 12-file shelf collapsed to two complete rows plus the third-row teaser.
- `collapsed-dark.png` — the same collapsed state in dark mode.

## Checks

- The collapsed 12-file fixture reads `Show 10 more files`.
- The browser interaction fixture expands through the twelfth file and returns to the collapsed state.
- The teaser cannot be clicked, focused, or reached through keyboard navigation.
- The disclosure button preserves focus and exposes `aria-expanded` and `aria-controls`.
- Expansion uses Scient's shared disclosure motion.
- Shelves with three or fewer files remain fully visible without a disclosure control.
- Hidden HTML rows defer rendered thumbnail loading until expansion.

final result: passed
