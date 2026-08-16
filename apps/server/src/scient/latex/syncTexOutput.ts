export type SyncTexRecord = Readonly<Record<string, string>>;

/**
 * SyncTeX prints one or more `result begin` / `result end` blocks. Values may
 * contain colons (notably Windows paths), so only the first colon separates a
 * key from its value.
 */
export function parseSyncTexRecords(output: string): ReadonlyArray<SyncTexRecord> {
  const records: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (/^synctex result begin$/iu.test(line)) {
      current = {};
      continue;
    }
    if (/^synctex result end$/iu.test(line)) {
      if (current !== null) records.push(current);
      current = null;
      continue;
    }
    if (current === null) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    current[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return records;
}

function finite(record: SyncTexRecord, key: string): number | null {
  const raw = record[key];
  if (raw === undefined || raw.length === 0) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export interface ParsedSyncTexForwardLocation {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function parseSyncTexForwardLocation(output: string): ParsedSyncTexForwardLocation | null {
  for (const record of parseSyncTexRecords(output)) {
    const page = finite(record, "Page");
    // `h`/`v` are the typeset box position. Older SyncTeX versions only
    // expose `x`/`y`, so retain that compatible fallback.
    const x = finite(record, "h") ?? finite(record, "x");
    const y = finite(record, "v") ?? finite(record, "y");
    if (page === null || x === null || y === null || page < 1 || x < 0 || y < 0) continue;
    return {
      page: Math.trunc(page),
      x,
      y,
      width: Math.max(0, finite(record, "W") ?? 0),
      height: Math.max(0, finite(record, "H") ?? 0),
    };
  }
  return null;
}

export interface ParsedSyncTexInverseLocation {
  readonly input: string;
  readonly line: number;
  readonly column: number | null;
}

export function parseSyncTexInverseLocation(output: string): ParsedSyncTexInverseLocation | null {
  for (const record of parseSyncTexRecords(output)) {
    const input = record.Input;
    const line = finite(record, "Line");
    const column = finite(record, "Column");
    if (input === undefined || input.length === 0 || line === null || line < 1) continue;
    return {
      input,
      line: Math.trunc(line),
      column: column === null || column < 0 ? null : Math.trunc(column),
    };
  }
  return null;
}
