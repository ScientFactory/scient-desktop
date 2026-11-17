# Web UI

## Primitives

Controls come from [`components/ui`](../../apps/web/src/components/ui).
[AGENTS.md](../../AGENTS.md#shared-quality-defaults) says how to use and extend them.

Don't style a raw `<button>`, `<input>`, `<select>`, or `<textarea>` to look like a control a
primitive provides. Raw elements are right when the element isn't that control: semantic rows, tabs,
resize handles, swatches, editor surfaces, anything whose behavior or geometry differs by design.

## Styles

Style with Tailwind classes in the component that renders the element.

- Global CSS, in [`index.css`](../../apps/web/src/index.css) or any other stylesheet, is only for
  what classes on the owning component can't express: generated Markdown or imperative DOM, custom
  elements and shadow roots, animations, runtime theme variables, and browser or Electron
  integration.
- No `style={{ ... }}` or inline `<style>` for static values a class covers. Values computed at
  runtime are fine.
- Theme-only rules use `@variant dark` and `@variant light`, not `.dark` selectors.

## Composition

The composer banners are the reference.

- [`ComposerBanner.tsx`](../../apps/web/src/components/chat/ComposerBanner.tsx) exports one object
  of small slots. Slots own their classes, take `className`, and spread the rest of their props,
  merging classes with `cn`. Variants and density are props on `Root`. A slot that needs a control
  renders `Button`.
- [`ComposerBannerStack.tsx`](../../apps/web/src/components/chat/ComposerBannerStack.tsx) composes
  the slots and owns only stack behavior: priority, expand and collapse, dismiss transitions.

Build new UI the same way. Compose or extend a component instead of copying its markup and classes.
When a call site repeats a treatment another one already uses, make it a variant or a slot on the
shared component. A new composer banner or notice uses the `ComposerBanner` slots.

## UI checklist

Check each changed screen against this list, in light and dark, at a normal window size and at the
narrowest width it supports. The PR shows before and after, light and dark, at the normal size
([AGENTS.md](../../AGENTS.md#verification)); add the narrow width when it looks different. A new
screen has no before. An item the change inherits and cannot fix in its scope is marked in the PR as
inherited, with the reason.

- **Made of the screen's own parts.** New states are variants of the components the screen already
  uses. Show a proposal as a screenshot of the real app, not a drawing.
- **Nothing clipped, covered or uneven.** No edge cut off by an overflow or scroll container, no
  control on top of or under another, and controls in one row are the same height. A whole-window
  screenshot hides this: check it in the running app and look at enlarged crops of toolbars and
  edges.
- **One focus border.** A focused control shows one thin, darker border, never a ring or halo; when
  the change adds or restyles a control, one screenshot shows it focused. A control that shows the
  halo gets its `data-slot` in
  [`scient-form-focus.css`](../../apps/web/src/scient/presentation/scient-form-focus.css).
- **No card in a card.** Items in a settings section are rows of that section (`SettingsRow`),
  aligned with the sections around it.
- **Say it once.** One status indicator per thing, no repeated labels or titles, silent success,
  and no internal ids or hashes.
- **Status on the item.** A state such as "Coming soon" or "Signed in" sits beside the item's name,
  and the item keeps its place when the state changes.
- **No extra steps.** No checking, loading or proof screen the action does not need. When a screen's
  logic is wrong, remove the step instead of rewording it.
- **Few words.** Labels are a few words. If every item needs a label to say who it is for, separate
  the audiences by place instead.

### Screenshots in a PR

The repository is public, so screenshots show synthetic state only, and they are pushed only when
opening the PR is authorized. Any real browser can take them: the dev app, `vp run dev`, or a browser
test that renders the real component, kept uncommitted. They go on a branch of their own, which runs no CI, is never merged
and is kept. From the PR's checkout, with the images in `$shots`:

```sh
branch=$(git branch --show-current)
ref="refs/heads/review-assets/$branch"
tree=$(for f in "$shots"/*.png; do
  printf '100644 blob %s\t%s\n' "$(git hash-object -w "$f")" "$(basename "$f")"
done | git mktree)
prev=$(git ls-remote origin "$ref" | cut -f1)  # a later round keeps the earlier images
if [ -n "$prev" ]; then
  git fetch origin "$ref" && commit=$(git commit-tree "$tree" -p "$prev" -m "PR screenshots")
else
  commit=$(git commit-tree "$tree" -m "PR screenshots")
fi
git push origin "${commit}:${ref}"
echo "https://raw.githubusercontent.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/$commit/"
```

Embed each image as that printed address followed by its file name. Addresses by commit never
change, so a later round adds images without replacing the ones reviewers already saw.

## Handlers in large components

V8 gives every closure created in one render a single shared scope. A memoized handler keeps
the scope of the render that created it, and that scope holds the other memoized values of that
render. When handlers in one component change at different times, each keeps an older scope that
holds older handlers, and old renders, with their server config and thread data, stay in memory
for as long as the component is mounted. React Compiler's memoized closures do the same.

In large, long-lived components such as `ChatView` and `ChatComposer`, write handlers as plain
functions and wrap them with [`useStableCallback`](../../apps/web/src/hooks/useStableCallback.ts)
only where they leave the component: props, hook dependency arrays, and effect or memo bodies.
Calls inside the component keep the plain function, so work that resumes after an `await` still
acts on the render it started in. A function that a child calls during render, or after an
`await`, comes from a module-level factory memoized on its inputs, so its closure keeps only
those inputs.

## React Compiler

The compiler memoizes a component or hook only when it can prove the code follows React's rules.
Anything it can't prove, such as reading a ref during render or calling `setState` from an effect,
makes it skip the whole function without a build error. Lint reports each skip as a
`react(...)` warning with the note "React Compiler skipped optimizing this component or hook".

Every file under `apps/web/src` must compile. Lint makes those rules errors there, and
`t3code/no-manual-memo` rejects `useMemo` and `useCallback`, which the compiler makes redundant;
no upstream rule bans them outright. It also rejects `"use memo"`. The compiler withholds a cache
scope when a value reaches plain function calls on both sides of a hook call. A `"use memo"`
helper forces one, but hides the ordering problem. Fix the order instead: plain uses of a value go
before the hook, or the helper is inlined. A `use*` helper that calls no hook is compiled as a
plain function and caches nothing, so a derived-value helper reads its source hook itself instead
of taking the value as an argument. `t3code/no-hookless-use-function` rejects a `use*` function
that calls no hook. Lint misses some bailouts, notably `try` with `finally` and
`throw` inside `try`, so [`reactCompilerCoverage.test.ts`](../../apps/web/src/reactCompilerCoverage.test.ts)
compiles every file and fails on any skip. Async handlers rarely need `try`: an
atom command settles into a result, so cleanup can follow the `await`. `useStableCallback` still
marks handlers that leave a large component, as described above.
