/**
 * A saved data view is an ordinary DuckDB SQL file in the project, such as `views/adults.sql`,
 * that reads its datasets by quoted relative path, so it runs unchanged in any DuckDB:
 *
 *     SELECT * FROM 'data/cohort.parquet' WHERE age >= 18
 *
 * A run declared to read a view also depends on the datasets the view names.
 */
const SQL_TOKEN =
  /--[^\n]*|\/\*[\s\S]*?\*\/|(\$[A-Za-z_]\w*\$|\$\$)[\s\S]*?\1|"(?:""|[^"])*"|'(?:''|[^'])*'|[a-z_]\w*|[^\s]/giu;
const COMPRESSION_EXTENSION = /\.(?:gz|zst|bz2|xz|lz4)$/iu;
const DATASET_EXTENSION = /\.(csv|tsv|tab|txt|parquet|json|jsonl|ndjson|xlsx|arrow|feather|ipc)$/iu;
const GLOB = /[*?[]/u;
const FILE_READERS = new Set([
  "read_csv",
  "read_csv_auto",
  "read_parquet",
  "parquet_scan",
  "read_json",
  "read_json_auto",
  "read_ndjson",
  "read_ndjson_auto",
]);

function sqlTokens(sql: string) {
  return Array.from(sql.matchAll(SQL_TOKEN)).filter(
    ([text]) => !text.startsWith("--") && !text.startsWith("/*"),
  );
}

function* pathTokens(sql: string) {
  let previous = "";
  let beforePrevious = "";
  let readerList = false;
  for (const match of sqlTokens(sql)) {
    const text = match[0];
    const relation = previous === "from" || previous === "join";
    const readerArg = previous === "(" && FILE_READERS.has(beforePrevious);
    if (text === "[" && readerArg) readerList = true;
    if (text === "]") readerList = false;
    const quote = text[0];
    if (quote === "'" || (relation && quote === '"')) {
      const path = text.slice(1, -1).replaceAll(quote + quote, quote);
      const extension = DATASET_EXTENSION.exec(
        path.replace(COMPRESSION_EXTENSION, ""),
      )?.[1]?.toLowerCase();
      if (extension !== undefined) {
        yield {
          path,
          extension,
          start: match.index,
          end: match.index + text.length,
          relation,
          readerArg,
          readerList: readerList && (previous === "[" || previous === ","),
        };
      }
    }
    beforePrevious = previous;
    previous = text.toLowerCase();
  }
}

const outsideProject = (path: string) =>
  path.startsWith("/") || /[:\\\u0000-\u001f]/u.test(path) || path.split("/").includes("..");

const normalize = (path: string) => path.replace(/^(?:\.\/)+/u, "");

export function savedViewReferences(sql: string): {
  files: string[];
  globs: string[];
  dropped: string[];
} {
  const files = new Set<string>();
  const globs = new Set<string>();
  const dropped = new Set<string>();
  for (const { path } of pathTokens(sql)) {
    if (outsideProject(path)) dropped.add(path);
    else if (GLOB.test(path)) globs.add(normalize(path));
    else files.add(normalize(path));
  }
  return { files: [...files], globs: [...globs], dropped: [...dropped] };
}

/** Names in SQL that the reference scan cannot associate with project files. */
export function savedViewUnresolvedRelations(sql: string): ReadonlyArray<string> {
  const paths = new Set(Array.from(pathTokens(sql), (token) => token.start));
  const tokens = sqlTokens(sql);
  const names = new Set<string>();
  for (const [index, token] of tokens.entries()) {
    const previous = tokens[index - 1]?.[0].toLowerCase();
    const name = token[0];
    if (
      (previous === "from" || previous === "join") &&
      /^(?:"|[a-z_])/iu.test(name) &&
      !paths.has(token.index) &&
      tokens[index + 1]?.[0] !== "(" &&
      !/^(?:lateral|values)$/iu.test(name)
    )
      names.add(name);
  }
  return [...names];
}

/** The preview passes exact file names to DuckDB for these recognized reads. */
export async function expandSavedViewGlobs(
  sql: string,
  resolve: (pattern: string) => Promise<ReadonlyArray<string>>,
): Promise<string> {
  const chunks: string[] = [];
  let end = 0;
  for (const token of pathTokens(sql)) {
    if (!GLOB.test(token.path) || outsideProject(token.path)) continue;
    const reader =
      token.extension === "parquet"
        ? "read_parquet"
        : ["csv", "tsv", "tab", "txt"].includes(token.extension)
          ? "read_csv"
          : ["json", "jsonl", "ndjson"].includes(token.extension)
            ? "read_json"
            : undefined;
    if (!(token.relation ? reader : token.readerArg || token.readerList)) continue;
    const files = await resolve(normalize(token.path));
    if (files.length === 0) continue;
    const literals = files.map((path) => "'" + path.replaceAll("'", "''") + "'").join(", ");
    const replacement = token.relation
      ? reader + "([" + literals + "])"
      : token.readerList
        ? literals
        : "[" + literals + "]";
    chunks.push(sql.slice(end, token.start), replacement);
    end = token.end;
  }
  return chunks.length === 0 ? sql : chunks.join("") + sql.slice(end);
}

/** Compatibility helper for callers that expand view file patterns. */
export function savedViewSources(sql: string): ReadonlyArray<string> {
  const { files, globs } = savedViewReferences(sql);
  return [...files, ...globs];
}

export const isSavedDataView = (path: string) => path.toLowerCase().endsWith(".sql");
