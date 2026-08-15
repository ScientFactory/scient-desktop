# Scient chat visualization fixtures

Open this file in Scient's Markdown preview. Review it in light and dark
appearance. Confirm hover, selection, bound controls, expansion, state return,
reset, source display/copy, SVG/PNG export, whole-document copy, keyboard focus,
and the recovery cases at the end.

## Prior-major schema compatibility

This chart deliberately declares Vega-Lite v5. It must render without a
version-only warning, while Show source and Download JSON must retain the v5
schema exactly.

```vega-lite title="prior-major.vl.json"
{
  "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
  "title": "Compatible prior-major specification",
  "description": "A Vega-Lite v5 bar chart used to verify quiet backward-compatible rendering.",
  "data": {"values": [
    {"group": "Control", "response": 5.2},
    {"group": "Treatment", "response": 7.8}
  ]},
  "mark": "bar",
  "encoding": {
    "x": {"field": "group", "type": "nominal", "title": "Study arm"},
    "y": {"field": "response", "type": "quantitative", "title": "Mean response"},
    "tooltip": [
      {"field": "group", "type": "nominal", "title": "Study arm"},
      {"field": "response", "type": "quantitative", "title": "Mean response"}
    ]
  }
}
```

## Interactive treatment trend

```vega-lite title="treatment-response.vl.json"
{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "title": "Treatment response over time",
  "description": "Mean response by treatment and week. Hover a point for its confidence interval.",
  "data": {"values": [
    {"week": 0, "arm": "Control", "mean": 8.0, "low": 7.3, "high": 8.7},
    {"week": 4, "arm": "Control", "mean": 7.7, "low": 7.0, "high": 8.4},
    {"week": 8, "arm": "Control", "mean": 7.5, "low": 6.8, "high": 8.2},
    {"week": 0, "arm": "Treatment", "mean": 8.1, "low": 7.4, "high": 8.8},
    {"week": 4, "arm": "Treatment", "mean": 6.3, "low": 5.7, "high": 6.9},
    {"week": 8, "arm": "Treatment", "mean": 4.9, "low": 4.3, "high": 5.5}
  ]},
  "layer": [
    {"mark": {"type": "errorband", "opacity": 0.18},
     "encoding": {"y": {"field": "low", "type": "quantitative", "title": "Response (points)"},
                  "y2": {"field": "high"}, "color": {"field": "arm", "type": "nominal"}}},
    {"mark": {"type": "line", "point": true},
     "encoding": {"x": {"field": "week", "type": "quantitative", "title": "Week"},
                  "y": {"field": "mean", "type": "quantitative", "title": "Response (points)"},
                  "color": {"field": "arm", "type": "nominal", "title": "Study arm"},
                  "tooltip": [{"field": "arm"}, {"field": "week"}, {"field": "mean", "format": ".1f"},
                              {"field": "low", "format": ".1f"}, {"field": "high", "format": ".1f"}]}}
  ]
}
```

## Stable tooltip and cursor affordance

Move slowly within each bar and rapidly between bars. The tooltip must remain
stationary within one bar, update immediately between bars, stay inside the
viewport at both edges, and show a crosshair over inspectable marks.

```vega-lite title="stable-tooltip.vl.json"
{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "title": "Measurement stability by sample",
  "description": "Tall bars and edge values exercise stable mark-anchored tooltip positioning.",
  "data": {"values": [
    {"sample": "First edge", "mean": 92.4, "unit": "µmol/L"},
    {"sample": "Control A", "mean": 61.8, "unit": "µmol/L"},
    {"sample": "Control B", "mean": 47.3, "unit": "µmol/L"},
    {"sample": "Treatment A", "mean": 28.9, "unit": "µmol/L"},
    {"sample": "Last edge", "mean": 76.2, "unit": "µmol/L"}
  ]},
  "mark": "bar",
  "encoding": {
    "x": {"field": "sample", "type": "nominal", "title": "Sample"},
    "y": {"field": "mean", "type": "quantitative", "title": "Mean concentration"},
    "tooltip": [
      {"field": "sample", "type": "nominal", "title": "Sample"},
      {"field": "mean", "type": "quantitative", "title": "Mean", "format": ".1f"},
      {"field": "unit", "type": "nominal", "title": "Unit"}
    ]
  }
}
```

## Click selection and legend filtering

```vega-lite
{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "title": "Select a cohort or legend entry",
  "description": "Scatterplot of biomarkers. Click points or legend entries to focus a cohort.",
  "data": {"values": [
    {"x": 2.1, "y": 4.2, "cohort": "A", "sample": "A1"},
    {"x": 2.8, "y": 5.0, "cohort": "A", "sample": "A2"},
    {"x": 4.2, "y": 3.4, "cohort": "B", "sample": "B1"},
    {"x": 4.8, "y": 4.1, "cohort": "B", "sample": "B2"},
    {"x": 6.0, "y": 6.3, "cohort": "C", "sample": "C1"},
    {"x": 6.7, "y": 5.7, "cohort": "C", "sample": "C2"}
  ]},
  "params": [{"name": "focus", "select": {"type": "point", "fields": ["cohort"]}, "bind": "legend"}],
  "mark": {"type": "point", "filled": true, "size": 140},
  "encoding": {
    "x": {"field": "x", "type": "quantitative", "title": "Marker X (a.u.)"},
    "y": {"field": "y", "type": "quantitative", "title": "Marker Y (a.u.)"},
    "color": {"field": "cohort", "type": "nominal"},
    "opacity": {"condition": {"param": "focus", "value": 1}, "value": 0.18},
    "tooltip": [{"field": "sample"}, {"field": "cohort"}, {"field": "x"}, {"field": "y"}]
  }
}
```

## Bound scientific control

Move the threshold away from `0.5`, change Scient's light/dark appearance, and
confirm the slider and classification state survive the theme remount.

```vega-lite
{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "title": "Adjust the decision threshold",
  "description": "A slider changes the horizontal classification threshold.",
  "params": [{"name": "threshold", "value": 0.5, "bind": {"input": "range", "min": 0.1, "max": 0.9, "step": 0.1}}],
  "data": {"values": [
    {"sample": "S1", "score": 0.18}, {"sample": "S2", "score": 0.43},
    {"sample": "S3", "score": 0.61}, {"sample": "S4", "score": 0.82}
  ]},
  "layer": [
    {"mark": "bar", "encoding": {"x": {"field": "sample", "type": "nominal"},
      "y": {"field": "score", "type": "quantitative", "scale": {"domain": [0, 1]}},
      "color": {"condition": {"test": "datum.score >= threshold", "value": "#16a34a"}, "value": "#94a3b8"},
      "tooltip": [{"field": "sample"}, {"field": "score"}]}},
    {"mark": {"type": "rule", "strokeDash": [6, 4]},
     "encoding": {"y": {"datum": {"expr": "threshold"}, "type": "quantitative"}}}
  ]
}
```

## Layered hover compatibility

This intentionally leaves the top-level selection unscoped. Hovering a bar
must reveal its value without a duplicate `hover_tuple` failure.

```vega-lite title="layered-hover.vl.json"
{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "description": "A layered bar and label chart with one shared hover selection.",
  "data": {"values": [
    {"day": "Monday", "outcome": 4},
    {"day": "Tuesday", "outcome": 7},
    {"day": "Wednesday", "outcome": 5}
  ]},
  "params": [{"name": "hover", "select": {"type": "point", "on": "pointerover", "clear": "pointerout"}}],
  "layer": [
    {"mark": "bar", "encoding": {
      "x": {"field": "day", "type": "ordinal"},
      "y": {"field": "outcome", "type": "quantitative"},
      "opacity": {"condition": {"param": "hover", "value": 1}, "value": 0.45}
    }},
    {"transform": [{"filter": {"param": "hover"}}], "mark": {"type": "text", "dy": -8},
     "encoding": {
       "x": {"field": "day", "type": "ordinal"},
       "y": {"field": "outcome", "type": "quantitative"},
       "text": {"field": "outcome"}
     }}
  ]
}
```

## Layered legend compatibility

This reproduces the shared-legend pattern from the visual review. The legend
must remain visible and clickable without a duplicate `legendSelect_tuple`
failure or a conflicting-legend warning.

```vega-lite title="layered-legend.vl.json"
{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "description": "Layered uncertainty, trend, and point marks controlled by one treatment legend.",
  "width": 520,
  "data": {"values": [
    {"week": 0, "group": "A", "low": 5, "mean": 6, "high": 7},
    {"week": 4, "group": "A", "low": 3, "mean": 4, "high": 5},
    {"week": 0, "group": "B", "low": 6, "mean": 7, "high": 8},
    {"week": 4, "group": "B", "low": 5, "mean": 6, "high": 7}
  ]},
  "params": [{"name": "legendSelect", "select": {"type": "point", "fields": ["group"]}, "bind": "legend"}],
  "layer": [
    {"mark": {"type": "area", "opacity": 0.18}, "encoding": {
      "x": {"field": "week", "type": "quantitative"},
      "y": {"field": "low", "type": "quantitative"},
      "y2": {"field": "high"},
      "color": {"field": "group", "type": "nominal", "legend": null},
      "opacity": {"condition": {"param": "legendSelect", "value": 0.18}, "value": 0.04}
    }},
    {"mark": {"type": "line", "strokeWidth": 2}, "encoding": {
      "x": {"field": "week", "type": "quantitative"},
      "y": {"field": "mean", "type": "quantitative"},
      "color": {"field": "group", "type": "nominal", "legend": {"title": "Treatment group"}},
      "opacity": {"condition": {"param": "legendSelect", "value": 1}, "value": 0.15}
    }},
    {"mark": {"type": "point", "filled": true, "size": 80}, "encoding": {
      "x": {"field": "week", "type": "quantitative"},
      "y": {"field": "mean", "type": "quantitative"},
      "color": {"field": "group", "type": "nominal", "legend": null},
      "opacity": {"condition": {"param": "legendSelect", "value": 1}, "value": 0.15},
      "tooltip": [{"field": "group"}, {"field": "week"}, {"field": "mean"}]
    }}
  ]
}
```

## Unicode and RTL labels

```vega-lite title="מדידות.vl.json"
{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "title": "תוצאות לפי קבוצה",
  "description": "Bar chart with Hebrew labels and Unicode scientific units.",
  "data": {"values": [{"קבוצה": "ביקורת", "ערך": 12.4}, {"קבוצה": "טיפול", "ערך": 18.7}]},
  "mark": "bar",
  "encoding": {
    "x": {"field": "קבוצה", "type": "nominal", "title": "קבוצה"},
    "y": {"field": "ערך", "type": "quantitative", "title": "ריכוז (µmol/L)"},
    "tooltip": [{"field": "קבוצה"}, {"field": "ערך", "format": ".1f"}]
  }
}
```

## Data URI

```vega-lite
{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "description": "Chart loaded from a self-contained CSV data URI.",
  "data": {"url": "data:text/csv;charset=utf-8,category%2Cvalue%0AA%2C3%0AB%2C7", "format": {"type": "csv"}},
  "mark": "bar",
  "encoding": {"x": {"field": "category", "type": "nominal"}, "y": {"field": "value", "type": "quantitative"}}
}
```

## Two independent charts

```vega-lite
{"data":{"values":[{"x":"A","y":1},{"x":"B","y":2}]},"mark":"bar","encoding":{"x":{"field":"x"},"y":{"field":"y","type":"quantitative"}}}
```

```vega-lite
{"data":{"values":[{"x":"A","y":2},{"x":"B","y":1}]},"mark":"line","encoding":{"x":{"field":"x"},"y":{"field":"y","type":"quantitative"}}}
```

## Composed layered-selection compatibility

Both vertically concatenated child charts deliberately leave their layered
selection unscoped. Each hover must reveal only its own label without a
duplicate signal error.

```vega-lite title="composed-layered-hover.vl.json"
{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "description": "Two composed layered charts with independently scoped hover selections.",
  "vconcat": [
    {
      "width": 480,
      "data": {"values": [{"sample": "A", "value": 4}, {"sample": "B", "value": 7}]},
      "params": [{"name": "upperHover", "select": {"type": "point", "on": "pointerover", "clear": "pointerout"}}],
      "layer": [
        {"mark": "bar", "encoding": {"x": {"field": "sample"}, "y": {"field": "value", "type": "quantitative"}, "opacity": {"condition": {"param": "upperHover", "value": 1}, "value": 0.45}}},
        {"transform": [{"filter": {"param": "upperHover"}}], "mark": {"type": "text", "dy": -8}, "encoding": {"x": {"field": "sample"}, "y": {"field": "value", "type": "quantitative"}, "text": {"field": "value"}}}
      ]
    },
    {
      "width": 480,
      "data": {"values": [{"sample": "C", "value": 3}, {"sample": "D", "value": 6}]},
      "params": [{"name": "lowerHover", "select": {"type": "point", "on": "pointerover", "clear": "pointerout"}}],
      "layer": [
        {"mark": "point", "encoding": {"x": {"field": "sample"}, "y": {"field": "value", "type": "quantitative"}, "size": {"condition": {"param": "lowerHover", "value": 220}, "value": 80}}},
        {"transform": [{"filter": {"param": "lowerHover"}}], "mark": {"type": "text", "dy": -10}, "encoding": {"x": {"field": "sample"}, "y": {"field": "value", "type": "quantitative"}, "text": {"field": "value"}}}
      ]
    }
  ]
}
```

## Faceted authored sizing

This fixed-size facet must preserve its two-column composition rather than
turning each child into a full-container-width chart.

```vega-lite title="faceted-response.vl.json"
{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "description": "A fixed-width faceted response chart used to verify authored composition sizing.",
  "data": {"values": [
    {"arm": "Control", "week": 0, "response": 8.0},
    {"arm": "Control", "week": 4, "response": 7.6},
    {"arm": "Treatment", "week": 0, "response": 8.1},
    {"arm": "Treatment", "week": 4, "response": 6.2}
  ]},
  "facet": {"column": {"field": "arm", "type": "nominal"}},
  "spec": {
    "width": 220,
    "mark": {"type": "line", "point": true},
    "encoding": {
      "x": {"field": "week", "type": "quantitative", "title": "Week"},
      "y": {"field": "response", "type": "quantitative", "title": "Response"}
    }
  }
}
```

## Deliberately malformed JSON

```vega-lite
{ "mark": "bar", "encoding":
```

## Deliberately invalid Vega-Lite

```vega-lite
{"description":"Readable source must survive a compiler error.","mark":{"type":"not-a-real-mark"},"data":{"values":[{"x":1}]}}
```

## Deliberately unsupported relative data

```vega-lite
{"data":{"url":"./results.csv"},"mark":"point","encoding":{"x":{"field":"x","type":"quantitative"},"y":{"field":"y","type":"quantitative"}}}
```

## Deliberately empty source

```vega-lite title="empty.vl.json"

```

## Deliberately unsupported future major

```vega-lite title="future-major.vl.json"
{"$schema":"https://vega.github.io/schema/vega-lite/v999.json","description":"This must report an unsupported future major without changing its source.","data":{"values":[{"x":"A","y":1}]},"mark":"bar","encoding":{"x":{"field":"x"},"y":{"field":"y","type":"quantitative"}}}
```
