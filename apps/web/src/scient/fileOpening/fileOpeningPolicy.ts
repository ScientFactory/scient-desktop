export const SCIENT_DEFAULT_RENDER_MARKDOWN = true;

/**
 * Files Scient opens in the integrated browser when the runtime supports it.
 * Source remains available from the file tree's context menu.
 */
export function shouldOpenInBrowserByDefault(path: string): boolean {
  const filePath = path.split(/[?#]/, 1)[0] ?? "";
  return /\.html?$/i.test(filePath);
}
