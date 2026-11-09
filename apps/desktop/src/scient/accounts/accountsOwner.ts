/**
 * The app window that runs Accounts' background work (Main fill, back-fill, withdrawal, delivery
 * to other computers): the oldest one still open, so the role moves only when that one closes.
 */
export function accountsOwner(
  windows: ReadonlyArray<{ readonly id: number; readonly webContents: { readonly id: number } }>,
): number | undefined {
  let oldest: (typeof windows)[number] | undefined;
  for (const window of windows) if (!oldest || window.id < oldest.id) oldest = window;
  return oldest?.webContents.id;
}
