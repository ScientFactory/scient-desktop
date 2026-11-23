# Build a new PowerPoint deck

Read when creating a new deck with pptxgenjs. Keep the build script with the working files. In this example it takes the output path as its first argument. Run it from the workspace with the staged module path.

```sh
NODE_PATH="$TOOLS/node/node_modules" node build.cjs raw.pptx
NODE_PATH="$TOOLS/node/node_modules" node "$TOOLS/ooxml/apply_theme.cjs" raw.pptx theme.json out.pptx
```

1. **Set the layout before adding slides.** `pres.layout = "LAYOUT_16x9"` gives a 10 × 5.625 in canvas. Use the required venue dimensions if they differ. Use inches for your geometry. Done when all placements use the selected canvas.
2. **Define shared design.** Set `pres.theme` with `headFontFace` and `bodyFontFace`. Set palette values as named six-digit hex strings. Pass fresh options to every `add*` call, including fresh nested objects and arrays such as `shadow`. pptxgenjs mutates options while converting units. Use a factory that returns a new object for each call. Use `defineSlideMaster` for backgrounds, reusable elements and named title/body placeholders. Create sections with `addSection({ title })` before the slides in each section when it helps navigation. Add slides with `addSlide({ masterName })` and write into placeholders with `addText(text, { placeholder: name })`. Check the explicit `PP_PLACEHOLDER.TITLE` type in python-pptx when reading the deck back. A custom master can use a nonzero placeholder index, which `shapes.title` can miss. Done when each slide uses its intended layout and the title appears in the title placeholder.
3. **Add editable content.** Use `addChart` with series and categories from the cited source, or label example data as synthetic. Use `addTable` for tabular content. Use an image for an unsupported chart type and identify the exception when delivering. Keep image aspect ratios. For conference talks, lead with a figure where the data supports one, give each slide one message and place citations and speaking cues in the notes. For LibreOffice QA, prefer typefaces present on the QA host and in the target viewer, such as Arial or Georgia when installed. If the reference mandates another font, retain it and disclose any substitutions. Done when chart/data readback matches the source and the notes contain the citations.
4. **Write and apply the palette.** Finish `pres.writeFile` before the post-pass. `theme.json` takes `name` and all twelve theme slots (`dk1`, `lt1`, `dk2`, `lt2`, `accent1` through `accent6`, `hlink`, `folHlink`), flat or under `colors`. pptxgenjs sets theme fonts and the post-pass writes the palette. The helper repairs the zero-crossing chart XML and rejects invalid RGB and dash values. In hex-only chart options, supply palette hex values without `#`. Done when the post-pass succeeds and the output passes the three gates in [SKILL.md](../SKILL.md).

## Check native charts

Read for every native chart, including a single clustered column chart.

- For stacked or 100% stacked bars and columns, set `dataLabelPosition` to `ctr`, `inEnd` or `inBase`. PowerPoint can repair or discard a chart that uses `outEnd`.
- For a secondary-axis combo, set `secondaryValAxis: true` and `secondaryCatAxis: true` in that plot's options. Supply matching `valAxes: [primaryValue, secondaryValue]` and `catAxes: [primaryCategory, secondaryCategory]` at the chart level. Provide the primary option objects too, even when empty.
- After writing the deck and applying the palette, run `"$PY" "$DOC" validate out.pptx`. The bundled pptxgenjs can emit an undeclared series-axis reference even on a single 2-D plot. If the diagnostic identifies a stray reference and the intended axes are already declared, add this post-generation step to the build.

  ```sh
  "$PY" "$TOOLS/ooxml/pptx_fix_chart_axes.py" out.pptx checked.pptx
  ```

  The helper removes only plot references to axis IDs absent from the same plot area and validates before publishing the separate deck. If an intended axis is missing, repair the chart options and rebuild. Check distinct category or date and value axes on 2-D bar and line plots.

- If the wrapper misses any chart in a trusted fixture, open the deck in PowerPoint or try a direct LibreOffice export under a fresh profile. Use the direct route only on trusted fixtures.

  ```sh
  QA=$(mktemp -d "$PWD/work/chart-qa.XXXXXXXX")
  soffice "-env:UserInstallation=file://$QA/profile" --headless --convert-to pdf --outdir "$QA" checked.pptx
  pdftoppm -r 130 -png "$QA/checked.pdf" "$QA/page"
  ```

  Compare category labels, values and series ordering in the image, the chart XML cache and the linked embedded workbook. Record any viewer discrepancy.

Done when package validation passes and the rendered plots agree with the chart cache, workbook and source data.
