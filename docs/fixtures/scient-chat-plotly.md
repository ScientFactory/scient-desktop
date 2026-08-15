# Scient Plotly chat fixtures

Open this file in Scient's Markdown preview. Review it in light and dark
appearance. Confirm hover, zoom/pan/orbit, legend toggles, animation, expansion,
state return, reset, source copy/download, SVG/PNG export, keyboard focus,
offscreen return, and the recovery case at the end.

## Statistical figure with uncertainty and math

```plotly title="dose-response.plotly.json"
{
  "data": [{
    "type": "scatter",
    "mode": "lines+markers",
    "name": "Treatment",
    "x": [0, 1, 2, 4, 8],
    "y": [1.0, 1.8, 3.2, 5.5, 7.1],
    "error_y": {"type": "data", "array": [0.2, 0.25, 0.35, 0.4, 0.5], "visible": true},
    "hovertemplate": "Dose: %{x} mg/L<br>Response: %{y:.2f} ± %{error_y.array:.2f}<extra>%{fullData.name}</extra>"
  }],
  "layout": {
    "title": {"text": "Dose response: $E = E_{max} C/(EC_{50}+C)$"},
    "xaxis": {"title": {"text": "Dose (mg/L)"}},
    "yaxis": {"title": {"text": "Response (a.u.)"}},
    "meta": {"description": "Treatment response increases with dose and includes standard-error bars."}
  }
}
```

## WebGL 3D scientific surface

Orbit, zoom, expand, close, and confirm that the same camera returns inline.

```plotly title="energy-surface.plotly.json"
{
  "data": [{
    "type": "surface",
    "x": [-2, -1, 0, 1, 2],
    "y": [-2, -1, 0, 1, 2],
    "z": [[8,5,4,5,8],[5,2,1,2,5],[4,1,0,1,4],[5,2,1,2,5],[8,5,4,5,8]],
    "colorscale": "Viridis",
    "colorbar": {"title": {"text": "Energy (kJ/mol)"}}
  }],
  "layout": {
    "title": {"text": "Model energy landscape"},
    "scene": {
      "xaxis": {"title": {"text": "Parameter A"}},
      "yaxis": {"title": {"text": "Parameter B"}},
      "zaxis": {"title": {"text": "Energy (kJ/mol)"}}
    },
    "meta": {"description": "A three-dimensional bowl-shaped energy surface with a minimum at the origin."}
  }
}
```

## Animated trajectory

Use Play, pause, scrub, expand, and return to the inline figure.

```plotly title="trajectory.plotly.json"
{
  "data": [{"type": "scatter", "mode": "markers", "x": [0], "y": [0], "marker": {"size": 14}}],
  "layout": {
    "title": {"text": "Particle trajectory"},
    "xaxis": {"range": [0, 4], "title": {"text": "Time (s)"}},
    "yaxis": {"range": [0, 16], "title": {"text": "Position (mm)"}},
    "updatemenus": [{"type": "buttons", "buttons": [
      {"label": "Play", "method": "animate", "args": [null, {"frame": {"duration": 350, "redraw": false}, "fromcurrent": true}]},
      {"label": "Pause", "method": "animate", "args": [[null], {"mode": "immediate", "frame": {"duration": 0, "redraw": false}}]}
    ]}],
    "sliders": [{"steps": [
      {"label": "0", "method": "animate", "args": [["0"], {"mode": "immediate"}]},
      {"label": "1", "method": "animate", "args": [["1"], {"mode": "immediate"}]},
      {"label": "2", "method": "animate", "args": [["2"], {"mode": "immediate"}]},
      {"label": "3", "method": "animate", "args": [["3"], {"mode": "immediate"}]},
      {"label": "4", "method": "animate", "args": [["4"], {"mode": "immediate"}]}
    ]}],
    "meta": {"description": "An animated point follows a quadratic position trajectory over five time steps."}
  },
  "frames": [
    {"name": "0", "data": [{"x": [0], "y": [0]}]},
    {"name": "1", "data": [{"x": [1], "y": [1]}]},
    {"name": "2", "data": [{"x": [2], "y": [4]}]},
    {"name": "3", "data": [{"x": [3], "y": [9]}]},
    {"name": "4", "data": [{"x": [4], "y": [16]}]}
  ]
}
```

## WebGL scatter regression set

These nearby WebGL figures exercise ordinary numeric arrays, eviction, restoration,
and expanded-view state transfer.

```plotly title="scattergl-array-a.plotly.json"
{
  "data": [{
    "type": "scattergl",
    "mode": "markers",
    "name": "Array A",
    "x": [0,1,2,3,4,5,6,7],
    "y": [0,1,4,9,16,25,36,49],
    "marker": {"size": 10, "color": "#38bdf8"}
  }],
  "layout": {
    "title": {"text": "WebGL scatter with ordinary arrays"},
    "xaxis": {"title": {"text": "Index"}},
    "yaxis": {"title": {"text": "Value"}},
    "meta": {"description": "A scattergl regression figure using ordinary numeric arrays."}
  }
}
```

```plotly title="scattergl-array-b.plotly.json"
{
  "data": [{
    "type": "scattergl",
    "mode": "markers",
    "name": "Array B",
    "x": [-4,-3,-2,-1,0,1,2,3,4],
    "y": [16,9,4,1,0,1,4,9,16],
    "marker": {"size": 10, "color": "#a78bfa"}
  }],
  "layout": {
    "title": {"text": "WebGL parabola"},
    "xaxis": {"title": {"text": "Position"}},
    "yaxis": {"title": {"text": "Distance"}},
    "meta": {"description": "A second nearby WebGL scatter figure for working-set eviction."}
  }
}
```

```plotly title="scattergl-array-c.plotly.json"
{
  "data": [{
    "type": "scattergl",
    "mode": "lines+markers",
    "name": "Array C",
    "x": [0,1,2,3,4,5,6,7,8,9],
    "y": [2,3,5,8,13,21,34,55,89,144],
    "marker": {"size": 8, "color": "#34d399"},
    "line": {"color": "#34d399"}
  }],
  "layout": {
    "title": {"text": "WebGL growth series"},
    "xaxis": {"title": {"text": "Step"}},
    "yaxis": {"title": {"text": "Magnitude"}},
    "meta": {"description": "A third nearby WebGL figure for eviction and restoration."}
  }
}
```

## Unicode and RTL labels

```plotly title="מדידות.plotly.json"
{
  "data": [{
    "type": "bar",
    "x": ["ביקורת", "טיפול"],
    "y": [12.4, 18.7],
    "hovertemplate": "%{x}: %{y:.1f} µmol/L<extra></extra>"
  }],
  "layout": {
    "title": {"text": "תוצאות לפי קבוצה"},
    "xaxis": {"title": {"text": "קבוצה"}},
    "yaxis": {"title": {"text": "ריכוז (µmol/L)"}},
    "meta": {"description": "תרשים עמודות המשווה ריכוז בין קבוצת ביקורת לקבוצת טיפול."}
  }
}
```

## Deliberately malformed JSON

```plotly
{"data":[{"type":"scatter","x":[1,2],"y":[3,4]}
```
