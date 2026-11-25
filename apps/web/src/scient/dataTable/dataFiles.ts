import { isSavedDataView, savedViewReferences } from "@t3tools/shared/savedDataView";

/** Files the data grid reads in place on their environment. */
export const isScientDataFile = (path: string): boolean =>
  /\.(?:csv|tsv|parquet|xlsx|xlsm|ods)$/i.test(path);

/** Views have an ordinary source editor and a table surface. */
export function isScientSavedViewFile(path: string, sql?: string): boolean {
  if (!isSavedDataView(path)) return false;
  if (/^views[\\/]/iu.test(path)) return true;
  if (sql === undefined || !/^\s*(?:(?:--[^\n]*|\/\*[\s\S]*?\*\/)\s*)*(SELECT|WITH)\b/iu.test(sql))
    return false;
  const { files, globs, dropped } = savedViewReferences(sql);
  return files.length + globs.length + dropped.length > 0;
}

export const canSaveDataView = (path: string): boolean => /\.(?:csv|tsv|tab|parquet)$/iu.test(path);
