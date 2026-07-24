# HTML preview manual smoke test

These fixtures provide an obvious pass/fail check for the full local HTML browser.
They contain no external network resources and are safe to inspect directly.

## Local desktop development

Start the normal desktop development stack:

```sh
bun run dev:desktop
```

Then preview `interactive-preview.html`. The counter must increment and reset must work. Local
scripts, modules, workers, fetches, styles, images, and linked pages should load from the fixture
directory without a feature flag.

## Windows

1. Install and start the Windows test build.
2. Add this repository checkout as a Scient project.
3. In a project chat, ask Scient to find the HTML files under
   `docs/manual-testing/html-preview`.
4. Select **Preview** for `static-preview.html`.
5. Confirm that the page says **Static preview passed** and that the four checks are green.

Then preview `interactive-preview.html`. The counter must increment and reset must work, and the
local module, fetch, worker, and linked-page checks must all report success.

The Windows installer may be unsigned when it is produced by a build-only workflow. Windows
SmartScreen can therefore require an explicit **More info** then **Run anyway** confirmation. Do
not treat an unsigned test artifact as a release candidate.
