import { describe, expect, it } from "vite-plus/test";

import {
  expandSavedViewGlobs,
  savedViewReferences,
  savedViewSources,
  savedViewUnresolvedRelations,
} from "./savedDataView.ts";

describe("savedViewSources", () => {
  // A string literal that looks like a file counts too: declaring an extra input is safe.
  it("names the project datasets a view reads, once each, and nothing outside the project", () => {
    const sql = `-- from 'old/ignored.csv'
SELECT a.*, b.score FROM read_csv('data/cohort.csv') a
JOIN 'data/scores.parquet' b USING (id)
WHERE a.site <> 'x.csv' OR a.id IN (SELECT id FROM 'data/cohort.csv')
UNION ALL SELECT * FROM '/abs/elsewhere.csv' UNION ALL SELECT * FROM '../up.csv'
UNION ALL SELECT * FROM 'https://example.org/remote.parquet'`;
    expect(savedViewSources(sql)).toEqual(["data/cohort.csv", "data/scores.parquet", "x.csv"]);
  });
});

it("distinguishes concrete files, globs and paths outside the project", () => {
  const sql = `/* 'comment.csv' */ SELECT "'column.csv'" FROM 'data/patient''s--notes.csv'
JOIN 'data/batch[1-3].parquet' USING (id)
JOIN 'data/../outside.parquet' USING (id)
JOIN 'https://example.test/cohort.csv' USING (id)`;
  expect(savedViewReferences(sql)).toEqual({
    files: ["data/patient's--notes.csv"],
    globs: ["data/batch[1-3].parquet"],
    dropped: ["data/../outside.parquet", "https://example.test/cohort.csv"],
  });
  expect(savedViewSources(sql)).toEqual(["data/patient's--notes.csv", "data/batch[1-3].parquet"]);
});

it("traces compressed and Arrow files and quoted relation paths", () => {
  const sql = `SELECT "field.csv" FROM /* source */ "data/zip.csv.gz"
JOIN "data/a""b.arrow" USING (id)
JOIN read_parquet('data/part.parquet.zst') USING (id)
JOIN read_csv('data/pipe.tsv.bz2') USING (id)
JOIN 'data/tiles.csv.xz' USING (id)
JOIN 'data/analytics.feather' USING (id)
JOIN 'data/analytics.ipc' USING (id)
JOIN "./data/*.parquet" USING (id)
JOIN "/tmp/other.csv" USING (id)
JOIN remote_table USING (id)`;
  expect(savedViewReferences(sql)).toEqual({
    files: [
      "data/zip.csv.gz",
      'data/a"b.arrow',
      "data/part.parquet.zst",
      "data/pipe.tsv.bz2",
      "data/tiles.csv.xz",
      "data/analytics.feather",
      "data/analytics.ipc",
    ],
    globs: ["data/*.parquet"],
    dropped: ["/tmp/other.csv"],
  });
  expect(savedViewUnresolvedRelations(sql)).toEqual(["remote_table"]);
});

it("expands only file reads and preserves unrelated SQL literals", async () => {
  const sql = `SELECT 'data/*.parquet', $$FROM 'data/other/*.csv'$$ FROM "./data/*.parquet"
JOIN read_csv(['data/one.csv', 'data/*.csv.gz'], all_varchar = true) USING (id)`;
  const patterns: string[] = [];
  const expanded = await expandSavedViewGlobs(sql, async (pattern) => {
    patterns.push(pattern);
    return pattern.endsWith("parquet") ? ["data/one.parquet"] : ["data/two's.csv.gz"];
  });
  expect(patterns).toEqual(["data/*.parquet", "data/*.csv.gz"]);
  expect(expanded).toBe(
    `SELECT 'data/*.parquet', $$FROM 'data/other/*.csv'$$ FROM read_parquet(['data/one.parquet'])
JOIN read_csv(['data/one.csv', 'data/two''s.csv.gz'], all_varchar = true) USING (id)`,
  );
});
