import type { DataTableColumn, DataTableColumnType } from "@scientfactory/compute";

const INTEGER = /^[-+]?\d+$/;
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$|^[-+]?(?:inf|infinity|nan)$/i;
const BOOLEAN = /^(?:true|false)$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const MISSING = /^(?:|na|n\/a|nan|null|none)$/i;

const TEXT_TYPES: ReadonlyArray<readonly [DataTableColumnType, string, RegExp]> = [
  ["integer", "int", INTEGER],
  ["number", "float", NUMBER],
  ["boolean", "bool", BOOLEAN],
  ["date", "date", DATE],
  ["datetime", "datetime", DATETIME],
];

/** The narrowest type every present value in a text column satisfies. */
export function inferTextColumnType(
  values: ReadonlyArray<string | undefined>,
): Pick<DataTableColumn, "type" | "label"> {
  const present = values.flatMap((value) => {
    const trimmed = value?.trim();
    return trimmed === undefined || MISSING.test(trimmed) ? [] : [trimmed];
  });
  if (present.length === 0) return { type: "text", label: "text" };
  for (const [type, label, pattern] of TEXT_TYPES) {
    if (present.every((value) => pattern.test(value))) return { type, label };
  }
  return { type: "text", label: "text" };
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** ISO-like text for a date, dropping a midnight time and zero milliseconds. */
export function formatDate(date: Date, withTime: boolean): string {
  if (Number.isNaN(date.getTime())) return "";
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const milliseconds = date.getUTCMilliseconds();
  if (!withTime) return day;
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return `${day} ${time}${milliseconds ? `.${pad(milliseconds, 3)}` : ""}`;
}

/** Display text for a decoded value; null when it is missing. */
export function formatValue(value: unknown, dateTime = true): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isNaN(value) ? null : String(value);
  if (typeof value === "bigint" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return formatDate(value, dateTime);
  if (value instanceof Uint8Array) {
    const hex = Array.from(value.subarray(0, 32), (byte) => byte.toString(16).padStart(2, "0"));
    return `0x${hex.join("")}${value.length > 32 ? "…" : ""}`;
  }
  return JSON.stringify(value, (_key, nested: unknown) =>
    typeof nested === "bigint"
      ? String(nested)
      : nested instanceof Date
        ? formatDate(nested, true)
        : nested,
  );
}
