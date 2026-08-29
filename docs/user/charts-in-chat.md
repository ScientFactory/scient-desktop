# Interactive charts in chat

Ask the AI to visualize project data when a comparison, trend, distribution,
uncertainty, or relationship is easier to understand as a chart. Scient turns
completed `vega-lite` and `plotly` Markdown fences into interactive figures
inside the conversation. The same charts also render in Markdown file previews.

## Choose a chart format

- **Vega-Lite** is a good fit for concise 2D charts, statistical comparisons,
  distributions, uncertainty, and linked views.
- **Plotly** is a good fit for 3D figures, large point sets, animation,
  specialized scientific traces, and figures already produced by Python, R,
  or MATLAB.

You can ask the AI to choose the format, or name one when you need a particular
interaction or a portable figure specification.

## Explore and export a chart

Charts keep their native interactions. Depending on the figure, you can hover,
select, brush, zoom, pan, orbit, change a legend, use bound controls, or play an
animation. The chart card also lets you:

- expand the live chart without losing its current view;
- reset its interaction state;
- show, copy, or download the original JSON;
- download the current view as SVG or high-resolution PNG; and
- copy the current view as a PNG when the platform clipboard supports images.

The fenced JSON remains the source of truth in the conversation. Copying the
whole answer preserves that source rather than replacing it with a generated
image.

While an answer is still streaming, Scient shows the JSON as an ordinary code
block. Rendering begins after the answer settles. Invalid JSON, an unsupported
specification, unavailable network data, or a browser graphics problem produces
a recovery message for that chart without breaking the rest of the answer.

## Data and network access

Inline data is the most portable choice. A **Network data** badge appears before
a chart loads an absolute HTTP or HTTPS resource. The request comes from the
device viewing the chart, and the server must allow browser access. In a remote
session, `localhost` therefore means the viewing device, not necessarily the
computer running the project.

Relative project paths do not work as chart data URLs inside a chat message
because the message has no stable file location. Ask the AI to embed a
reasonable amount of data, use a reachable data endpoint, or create a project
artifact that loads the data in its own context. Remote images, map tiles,
GeoJSON, and similar resources may also require network access.

Unsized charts adapt to the available conversation width. Multi-panel charts
preserve their authored dimensions, so ask for dimensions appropriate to the
surface where you plan to use them.

## Save a durable figure

An inline chart is part of the conversation, not automatically a versioned
scientific output. Ask the AI to save a real `.vl.json`, `.plotly.json`, data,
SVG, or PNG file in the project when the figure should be reviewed, edited,
cited, shared, or reproduced later.
