/** Files the data grid reads in place on their environment. */
export const isScientDataFile = (path: string): boolean =>
  /\.(?:csv|tsv|parquet|xlsx|xlsm|ods)$/i.test(path);
