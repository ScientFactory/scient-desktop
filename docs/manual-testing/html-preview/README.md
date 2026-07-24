# HTML preview manual smoke test

These fixtures provide an obvious pass/fail check for the isolated HTML preview implementation.
They contain no external network resources and are safe to inspect directly.

## Local desktop development

Turbo only forwards explicitly allowlisted environment variables. Start the normal desktop
development stack with the rollout switch set before the Bun command:

```sh
SCIENT_EXECUTABLE_HTML_PREVIEW=1 bun run dev:desktop
```

Then preview `interactive-preview.html`. The counter must increment, reset must work, and external
network access must remain unavailable. The `scripts/dev-runner.test.ts` regression test verifies
that Turbo forwards this rollout switch.

## Windows

1. Install and start the Windows test build.
2. Add this repository checkout as a Scient project.
3. In a project chat, ask Scient to find the HTML files under
   `docs/manual-testing/html-preview`.
4. Select **Preview** for `static-preview.html`.
5. Confirm that the page says **Static preview passed** and that the four checks are green.

To test the isolated JavaScript path, start the test build from PowerShell with the rollout switch
enabled:

```powershell
$env:SCIENT_EXECUTABLE_HTML_PREVIEW = "1"
& "$env:LOCALAPPDATA\Programs\Scient\Scient.exe"
```

Then preview `interactive-preview.html`. The counter must increment, reset must work, and external
network access must remain unavailable.

The Windows installer may be unsigned when it is produced by a build-only workflow. Windows
SmartScreen can therefore require an explicit **More info** then **Run anyway** confirmation. Do
not treat an unsigned test artifact as a release candidate.
