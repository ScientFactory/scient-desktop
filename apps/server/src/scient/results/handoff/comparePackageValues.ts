import type { ResultHandoffValueDifference } from "@t3tools/contracts";
import { resultPointer } from "@t3tools/shared/computeResults";

const MAX_DIFFERENCES = 50;
const MAX_TEXT = 4096;

class NumericLiteral {
  readonly value: number;
  readonly text: string;

  constructor(value: number, text: string) {
    this.value = value;
    this.text = text;
  }
}

function parseValues(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { readonly source?: string }) =>
    typeof value === "number" ? new NumericLiteral(value, context?.source ?? String(value)) : value,
  );
}

function display(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value instanceof NumericLiteral) return value.text.slice(0, MAX_TEXT);
  if (Array.isArray(value)) return "[…]";
  if (value !== null && typeof value === "object") return "{…}";
  return JSON.stringify(value)?.slice(0, MAX_TEXT);
}

// The original decimal tokens distinguish integers beyond IEEE-754's exact range.
function normalizedDecimal(literal: string) {
  const [significand = "", exponent = "0"] = literal.toLowerCase().split("e");
  const negative = significand.startsWith("-");
  const [whole = "", fractional = ""] = significand.replace(/^-/, "").split(".");
  const digits = `${whole}${fractional}`.replace(/^0+/u, "");
  if (digits === "") return "0";
  const trimmed = digits.replace(/0+$/u, "");
  return `${negative ? "-" : ""}${trimmed}e${BigInt(exponent) - BigInt(fractional.length) + BigInt(digits.length - trimmed.length)}`;
}

export function comparePackageValues(
  expected: string,
  actual: string,
  tolerance: { readonly absolute: number; readonly relative: number },
) {
  const differences: ResultHandoffValueDifference[] = [];
  let differenceCount = 0;
  let maxAbsoluteError: { pointer: string; error: number } | undefined;
  let maxRelativeError: { pointer: string; error: number } | undefined;
  const stack = [
    { before: parseValues(expected), after: parseValues(actual), keys: [] as string[] },
  ];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    const { before, after, keys } = item;
    if (before === after) continue;
    const pointer = (keys.length === 0 ? "" : resultPointer(keys)).slice(0, MAX_TEXT);
    let absoluteDifference: number | undefined;
    let relativeDifference: number | undefined;
    if (before instanceof NumericLiteral && after instanceof NumericLiteral) {
      const exact =
        before.text === after.text ||
        normalizedDecimal(before.text) === normalizedDecimal(after.text);
      if (Number.isFinite(before.value) && Number.isFinite(after.value)) {
        const bothIntegers = /^-?\d+$/u.test(before.text) && /^-?\d+$/u.test(after.text);
        absoluteDifference = bothIntegers
          ? Math.abs(Number(BigInt(after.text) - BigInt(before.text)))
          : Math.abs(after.value - before.value);
        relativeDifference =
          before.value === 0 ? undefined : absoluteDifference / Math.abs(before.value);
        if (
          Number.isFinite(absoluteDifference) &&
          (maxAbsoluteError === undefined || absoluteDifference > maxAbsoluteError.error)
        ) {
          maxAbsoluteError = { pointer, error: absoluteDifference };
        }
        if (
          relativeDifference !== undefined &&
          Number.isFinite(relativeDifference) &&
          (maxRelativeError === undefined || relativeDifference > maxRelativeError.error)
        ) {
          maxRelativeError = { pointer, error: relativeDifference };
        }
        if (
          exact ||
          (!bothIntegers &&
            (tolerance.absolute > 0 || tolerance.relative > 0) &&
            Number.isFinite(absoluteDifference) &&
            absoluteDifference <= tolerance.absolute + tolerance.relative * Math.abs(before.value))
        )
          continue;
      } else if (exact) continue;
    } else if (
      before !== null &&
      after !== null &&
      typeof before === "object" &&
      typeof after === "object" &&
      !(before instanceof NumericLiteral) &&
      !(after instanceof NumericLiteral) &&
      Array.isArray(before) === Array.isArray(after)
    ) {
      const lhs: Record<string, unknown> = Object.fromEntries(Object.entries(before));
      const rhs: Record<string, unknown> = Object.fromEntries(Object.entries(after));
      const properties = new Set([...Object.keys(lhs), ...Object.keys(rhs)]);
      for (const key of properties) {
        stack.push({
          before: Object.hasOwn(lhs, key) ? lhs[key] : undefined,
          after: Object.hasOwn(rhs, key) ? rhs[key] : undefined,
          keys: [...keys, key],
        });
      }
      continue;
    }
    differenceCount += 1;
    if (differences.length >= MAX_DIFFERENCES) continue;
    const expectedText = display(before);
    const actualText = display(after);
    differences.push({
      pointer,
      ...(expectedText === undefined ? {} : { expected: expectedText }),
      ...(actualText === undefined ? {} : { actual: actualText }),
      ...(absoluteDifference === undefined || !Number.isFinite(absoluteDifference)
        ? {}
        : { absoluteDifference }),
      ...(relativeDifference === undefined || !Number.isFinite(relativeDifference)
        ? {}
        : { relativeDifference }),
    });
  }
  return {
    differenceCount,
    values: differences,
    ...(maxAbsoluteError === undefined ? {} : { maxAbsoluteError }),
    ...(maxRelativeError === undefined ? {} : { maxRelativeError }),
  };
}
