import { isSavedDataView } from "@t3tools/shared/savedDataView";

export type DataSnippetLanguage = "python" | "r" | "julia";

export function dataSnippetLanguage(path: string): DataSnippetLanguage {
  if (/\.r$/iu.test(path)) return "r";
  return /\.jl$/iu.test(path) ? "julia" : "python";
}

export function dataInputSnippet(path: string, language: DataSnippetLanguage, sheet = 0): string {
  const quote = (value: string) => {
    const literal = JSON.stringify(value);
    return language === "julia" ? literal.replaceAll("$", "\\$") : literal;
  };
  const file = quote(path);
  if (/\.(xlsx|xlsm|ods)$/iu.test(path)) {
    if (language === "python")
      return `import pandas as pd; data = pd.read_excel(${file}, sheet_name=${sheet})`;
    if (language === "r") {
      const reader = /\.ods$/iu.test(path) ? "readODS::read_ods" : "readxl::read_excel";
      return `data <- ${reader}(${file}, sheet = ${sheet + 1})`;
    }
    return /\.ods$/iu.test(path) ? "" : `using XLSX; data = XLSX.readtable(${file}, ${sheet + 1})`;
  }

  const sqlPath = `'${path.replaceAll("'", "''")}'`;
  const relation = /\.(tsv|tab)$/iu.test(path)
    ? `read_csv(${sqlPath}, header = true, delim = '${"\t"}')`
    : sqlPath;
  const sql = quote(`SELECT * FROM ${relation}`);
  const view = isSavedDataView(path);
  switch (language) {
    case "python":
      return `import duckdb; data = duckdb.sql(${view ? `open(${file}, encoding="utf-8").read()` : sql}).df()`;
    case "r":
      return `data <- DBI::dbGetQuery(DBI::dbConnect(duckdb::duckdb()), ${view ? `paste(readLines(${file}, encoding="UTF-8"), collapse="\\n")` : sql})`;
    case "julia":
      // oxlint-disable-next-line t3code/no-untranslated-copy -- executable Julia source.
      return `using DuckDB; data = DBInterface.execute(DBInterface.connect(DuckDB.DB, ":memory:"), ${view ? `read(${file}, String)` : sql})`;
  }
}
