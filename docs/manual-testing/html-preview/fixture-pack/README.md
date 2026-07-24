# HTML preview fixtures

Open these files through Scient to test its HTML and Markdown preview behavior.

- `static-brochure.html`: static layout, local image, and table.
- `interactive-demo.html`: buttons, forms, modules, fetch, workers, and linked-page navigation. It should be fully interactive whenever the file is opened.
- `long-report.html`: scrolling, table, and code-block layout.
- `broken-page.html`: a missing local image; the preview should remain usable.
- `preview-links.md`: rendered Markdown and file links.

The small supporting files beside the pages are intentional. They verify that a local HTML file can use the exact static assets, literal runtime dependencies, and linked pages it declares without turning its containing directory into a general-purpose file server.

Safe-preview boundaries to verify:

- Parent-directory references are reported and denied unless the user instead opens the actual site root through a confirmed development-server flow.
- Interactive local HTML can use its granted local graph but cannot navigate away, call local/private services, or send arbitrary network requests.
- Static documents may load only the exact public asset URLs declared in their markup; hostname resolution to a local/private address is denied.
- **Open original in default app** opens the file itself. Scient never exports its localhost capability URL to an unmanaged browser.
