export type SyncTexRecord = Readonly<Record<string, string>>;

/**
 * SyncTeX wraps an ordered candidate list in each `result begin` / `result
 * end` envelope. Every candidate starts with `Output:`; treating the whole
 * envelope as one record would let later candidates overwrite earlier, more
 * accurate ones. Values may contain colons (notably Windows paths), so only
 * the first colon separates a key from its value.
 */
export function parseSyncTexRecords(output: string): ReadonlyArray<SyncTexRecord> {
  const records: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  let insideResult = false;

  const flush = () => {
    if (current !== null && Object.keys(current).length > 0) records.push(current);
    current = null;
  };

  for (const rawLine of output.split(/\r?\n/u)) {
    const structuralLine = rawLine.trim();
    if (/^synctex result begin$/iu.test(structuralLine)) {
      flush();
      insideResult = true;
      continue;
    }
    if (/^synctex result end$/iu.test(structuralLine)) {
      flush();
      insideResult = false;
      continue;
    }
    if (!insideResult) continue;
    const separator = rawLine.indexOf(":");
    if (separator <= 0) continue;
    const key = rawLine.slice(0, separator).trim();
    if (key === "Output" && current !== null && Object.keys(current).length > 0) flush();
    current ??= {};
    current[key] = rawLine.slice(separator + 1);
  }
  flush();
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
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
}

export function parseSyncTexForwardLocations(
  output: string,
): ReadonlyArray<ParsedSyncTexForwardLocation> {
  return parseSyncTexRecords(output).flatMap((record) => {
    const page = finite(record, "Page");
    // `x`/`y` are the synchronization point. `h`/`v` are the origin of an
    // enclosing typeset box and can legitimately extend outside an RTL page.
    // A helper that omits the point can still fall back to that box origin.
    const x = finite(record, "x") ?? finite(record, "h");
    const y = finite(record, "y") ?? finite(record, "v");
    if (
      page === null ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      x === null ||
      y === null ||
      x < 0 ||
      y < 0
    ) {
      return [];
    }
    const boxX = finite(record, "h");
    const boxY = finite(record, "v");
    const width = finite(record, "W");
    const height = finite(record, "H");
    return [
      {
        page,
        x,
        y,
        box:
          boxX === null ||
          boxY === null ||
          width === null ||
          height === null ||
          width < 0 ||
          height < 0
            ? null
            : { x: boxX, y: boxY, width, height },
      },
    ];
  });
}

export function parseSyncTexForwardLocation(output: string): ParsedSyncTexForwardLocation | null {
  return parseSyncTexForwardLocations(output)[0] ?? null;
}

export interface ParsedSyncTexInverseLocation {
  readonly input: string;
  readonly line: number;
  readonly column: number | null;
}

export function parseSyncTexInverseLocations(
  output: string,
): ReadonlyArray<ParsedSyncTexInverseLocation> {
  return parseSyncTexRecords(output).flatMap((record) => {
    const input = record.Input;
    const line = finite(record, "Line");
    const column = finite(record, "Column");
    if (
      input === undefined ||
      input.length === 0 ||
      line === null ||
      !Number.isSafeInteger(line) ||
      line < 1 ||
      (column !== null && !Number.isSafeInteger(column))
    ) {
      return [];
    }
    return [
      {
        input,
        line,
        column: column === null || column < 1 ? null : column,
      },
    ];
  });
}

export function parseSyncTexInverseLocation(output: string): ParsedSyncTexInverseLocation | null {
  return parseSyncTexInverseLocations(output)[0] ?? null;
}
