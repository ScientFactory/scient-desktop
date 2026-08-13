export const SCIENT_DEFAULT_RENDER_MARKDOWN = true;
export const SCIENT_DEFAULT_FILE_EXPLORER_OPEN = false;

export function resolveInitialFileExplorerOpen(savedPreference: boolean | null): boolean {
  return savedPreference ?? SCIENT_DEFAULT_FILE_EXPLORER_OPEN;
}

/**
 * Files Scient opens in the integrated browser when the runtime supports it.
 * Source remains available from the file tree's context menu.
 */
export function shouldOpenInBrowserByDefault(path: string): boolean {
  const filePath = path.split(/[?#]/, 1)[0] ?? "";
  return /\.html?$/i.test(filePath);
}
