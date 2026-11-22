# HTML for print

Use HTML for a PDF only when it is the requested or established source. Keep layout in local CSS and assets at project-relative paths with exact case: the controlled renderer blocks remote resources, so fonts, scripts, styles and images must be local.

Set the paper size and margins with `@page` and use print CSS rather than a fixed browser viewport. Let long tables break and repeat their headers. Keep captions with figures, and reserve `break-inside: avoid` for small blocks, not whole long sections or tables. Remove fixed heights and overflow clipping that hide print content.

Have equations and graphics finished in the saved source before building: rendered math rather than a remote MathJax script, and content that is present without animation frames, scrolling or lazy loading. Prefer local SVG for diagrams and vector plots; use image resolution suited to the final print size and venue.

Check page breaks, dynamic content and missing assets on the returned PDF; a browser screenshot can't show print pagination. If the connected desktop renderer fails, keep the source and report the exact render or publication failure; opening the HTML and choosing Export PDF is a fallback for the user, not a completed export.
