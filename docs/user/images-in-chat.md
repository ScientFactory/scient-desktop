# Images in chat

Images in chat let you inspect plots, figures, diagrams, microscopy, and other
visual project outputs in the context of the conversation that produced or
discussed them.

Scient displays supported project images directly in a completed chat message
when the message uses ordinary Markdown image syntax:

```markdown
![Residuals by treatment group](results/residuals.svg)
```

The path is resolved relative to the current project. PNG, SVG, JPEG, WebP,
GIF, AVIF, and ICO files use the same image card. While an answer is still
streaming, the image remains ordinary Markdown and is loaded only after the
answer settles.

The resolved file must remain inside the current workspace. An absolute path,
an outside-workspace traversal, or a path in another environment is not granted
workspace-file authority merely because it appears in Markdown. Remote web
images retain ordinary Markdown image behavior rather than these project-file
actions.

The image card lets you:

- expand and zoom the figure;
- open the source file in Scient;
- copy the displayed image as PNG;
- download the unmodified original file;
- copy its project-relative path;
- refresh it after the file is regenerated; and
- switch among automatic, light, and dark inspection backgrounds.

The same file and image actions remain available after you expand the figure.

Use SVG for vector plots, diagrams, and publication figures when the producing
tool supports it. Use PNG for pixel data, screenshots, microscopy, heatmaps,
and broad compatibility. Alternative text should name what the figure shows;
the surrounding response should still explain its important conclusion.

Scient reads SVG through the browser's image pipeline rather than treating it
as an HTML document. The file keeps its vector quality, while scripts and
document-level interaction are not part of this static figure view. Use an
interactive chart format or the integrated browser when the content itself
needs controls or application behavior.

Missing, incomplete, or undecodable images produce a local recovery card. The
rest of the message remains readable, and you can retry after repairing or
regenerating the file.
