# Interactive charts in chat

Scient turns completed `vega-lite` and `plotly` Markdown fences into
interactive charts. Vega-Lite is a good fit for concise declarative 2D
comparisons, trends, distributions, uncertainty, and linked views. Plotly is a
good fit for 3D figures, WebGL or large point sets, animation, specialized
scientific traces, and figures already produced by Python, R, or MATLAB.
Markdown file previews use the same renderers.

Charts support their native interactions: Vega-Lite selections, brushing and
bound controls, and Plotly zoom, pan, orbit, hover, legend, animation, and
direct manipulation. Inline Cartesian figures preserve conversation scrolling
and use the stable Scient toolbar for zoom, pan, box selection, lasso selection,
and reset. Expanded figures additionally support scroll or pinch to zoom. The
Zoom toolbar button switches dragging to rectangle zoom. The chart card also
lets you:

- expand the live chart without losing its current interaction state;
- reset the interaction state;
- show, copy, or download the original JSON;
- download the current view as SVG or high-resolution PNG; and
- copy the current view as a PNG when the platform clipboard supports images.

Hover tooltips remain anchored to the active Vega-Lite mark while you inspect
it. Cursor changes distinguish tooltip inspection from clickable selections
and movable brushes without overriding cursor behavior declared by the chart.

While an answer is still streaming, Scient shows the JSON as an ordinary code
block. Rendering starts only after the answer settles and the chart approaches
the visible conversation. Invalid JSON, an invalid specification, a lost WebGL
context, exhausted graphics resources, or failed external data shows a local
recovery state without breaking the rest of the message. In long conversations,
Scient releases offscreen WebGL figures and restores their live view when they
return instead of leaving every GPU context mounted.

Scient uses one bundled, current Vega-Lite compiler. Compatible charts that
declare an older schema version render without a version-only warning, while a
chart declaring a newer major version reports that incompatibility rather than
silently dropping unsupported features. Plotly consumes portable figure JSON
with `data` and optional `layout`, `config`, and `frames`; HTML, Dash/Jupyter
wrappers, and Python source are not figure JSON. Plotly.py encoded arrays are
supported when their complete `dtype`, `bdata`, and optional `shape` values are
present; a truncated encoded array is reported as invalid source rather than as
a browser graphics failure. Original source remains unchanged in both
renderers.

Inline data is the most portable choice. A `Network data` badge appears before
a chart loads absolute HTTP or HTTPS resources. Those requests come from the
device viewing the chart, and public servers must allow browser access through
CORS. Localhost and private-network HTTP(S) addresses are supported for local
scientific data servers; `localhost` refers to the viewing device. Plotly keeps
its native handling for map tiles, remote images, GeoJSON, and geography
topology: Scient does not apply Vega-Lite's resource loader, credential,
timeout, or size policy to those Plotly requests. Relative or local file paths
need a future project-file adapter because a chat message has no stable
directory authority. The chart source is canonical: whole-message copy
preserves the fenced JSON rather than generated SVG. Plotly map tiles, remote
images, GeoJSON, and geography topology may require the network and are
identified in the card.

Unsized single and layered charts adapt to the available chat width. Faceted,
repeated, and concatenated charts preserve their authored child dimensions so
horizontal and vertical layouts are not silently distorted; their source
should choose dimensions that fit the intended surface.

For layered charts, Scient prepares a disposable interaction-safe render copy
when an otherwise shared selection would create duplicate internal signals.
This also applies when the layered chart is nested in a facet or concatenated
view. Theme changes preserve the chart's current selection and control state.
For Plotly, the disposable view receives responsive host defaults and preserves
authored templates. The JSON shown, copied, and downloaded from either card
remains exactly what the conversation contains.

An inline chart is not automatically a durable scientific artifact. Ask the
agent to create a real `.vl.json`, `.plotly.json`, data, SVG, or PNG file when
you need a versioned project asset.
