# Charts in Sheets and Slides

Read this for chart creation, editing, embedding or refresh. Read `sheets.md`
for source data and `slides.md` when touching a deck.

## Confirm the source, destination and audience

A Slides embed references a chart created in Sheets or takes a snapshot of
it. Identify the source spreadsheet and chart ID, and the requested destination
slide IDs. Reuse an existing chart for an embed or refresh when it fits. If the
data is only on a slide, get an authorized workbook destination before
transferring it or creating a source chart. Create a new workbook only if the
requested output authorizes it.

Deck viewers can see the embedded chart and the data it displays even when
they lack access to the source Sheet. Before adding or refreshing, confirm that
the displayed data is appropriate for the deck audience. Keep source sharing
as authorized. See the [Google guidance on linked objects](https://support.google.com/docs/answer/7009814).

## Prepare the data and add the chart

- Use a bounded data block with aligned domain and series rows. Keep totals and
  blank separators outside the plotted range. Use formulas for derived data.
  Use numeric types for numeric axes and date serials with date formats for
  date axes. Check order, legend labels and a plotted value against its source.
- Send an `addChart` request with `addChart.chart.spec` and
  `addChart.chart.position`. For a basic chart, set `spec.basicChart.chartType`
  (for example `COLUMN`, `LINE` or `SCATTER`). Scatter uses a numeric domain
  and numeric Y series. Set `headerCount: 1` for a column-oriented
  data block with one header row. Use `0` for headerless data. Omission allows inference.
- For a column-oriented basic chart, put a separate one-dimensional
  `GridRange` in each `domains[].domain.sourceRange.sources[]` and
  `series[].series.sourceRange.sources[]`. For example, generate A1:A13 as the
  domain and B1:B13 and C1:C13 as individual series using `sheets-grid`.
  Match row bounds, including any header. A pie chart uses a separate
  `spec.pieChart` with `domain` and `series` ChartData fields.
- Add the spec title, axis labels where needed, and a position clear of data.
  For an overlay, set `position.overlayPosition.anchorCell` and set
  `widthPixels` and `heightPixels` in that same overlay object.
  If an additional tab is in scope, `position.newSheet: true` places the chart
  on its own sheet. Capture `replies[].addChart.chart.chartId` or confirm the
  new ID by reading back metadata.

## Edit the existing chart

Check the current data and ranges first. `updateChartSpec` takes the
`chartId` and replaces the entire `spec`. Confirm that the connector read
returns the full current spec, including series, colors, axes and options,
before merging the requested edit into it. Chart IDs and titles alone are
insufficient. If you cannot obtain the complete spec, report the limitation
before writing.

## Embed or refresh in Slides

- Use `createSheetsChart` with `spreadsheetId`, `chartId`, and
  `elementProperties` containing the target `pageObjectId`, size and transform.
  Choose `linkingMode: "LINKED"` for a refreshable chart or
  `linkingMode: "NOT_LINKED_IMAGE"` for a static snapshot. Set it explicitly
  since omission produces an unlinked image.
- Use `refreshSheetsChart` with the embedded element's `objectId` on
  requested linked destinations only. If a refresh leaves plotted values
  unchanged, confirm that the source data and chart ranges include the new
  values. A recreated source chart has a new ID. Re-embed only where
  authorized and verify the new link, placement and stacking.
- Guard the deck batch with its fresh revision and verify the slide after
  each change.

## Verify

- Read back the Sheet spec and check the source, range bounds, domain order,
  series and labels. Compare a plotted value to the underlying cell.
- Inspect the rendered Sheet chart and the thumbnail of each changed slide.
  Check placement, aspect ratio, readability and axis labels.
- Report the Sheet and deck links, the embedded chart's link mode and the
  destinations refreshed.

See the [Sheets chart resource](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/charts)
and [Slides chart requests](https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/request#createsheetschartrequest).
