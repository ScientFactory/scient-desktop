/**
 * Scient-owned typography overrides for the interactive diff panel.
 *
 * This is intentionally separate from the shared diff-surface theme because
 * file preview consumes that theme too. The doubled attribute selectors keep
 * these values stronger than inherited per-panel defaults without changing
 * another renderer surface.
 */
export const SCIENT_DIFF_PANEL_TYPOGRAPHY_UNSAFE_CSS = `
[data-diffs-header][data-diffs-header] {
  font-size: var(--scient-font-size-diff-header, 14px) !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])
  [data-separator-content][data-separator-content],
[data-diffs-header][data-diffs-header] [data-additions-count],
[data-diffs-header][data-diffs-header] [data-deletions-count] {
  font-size: var(--scient-font-size-compact-meta, 13px) !important;
}
`;
