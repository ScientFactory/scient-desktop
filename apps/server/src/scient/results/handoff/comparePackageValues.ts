import type { ResultHandoffValueDifference } from "@t3tools/contracts";
import { resultPointer } from "@t3tools/shared/computeResults";

const MAX_DIFFERENCES = 50;
const MAX_TEXT = 4096;

class NumericLiteral {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}

function parseValues(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { readonly source?: string }) =>
    typeof value === "number" ? new NumericLiteral(context?.source ?? String(value)) : value,
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

/** An exact decimal, `units × 10^exponent`. */
interface Decimal {
  readonly units: bigint;
  readonly exponent: number;
}
/** Digits of precision kept when values differ hugely in scale; smaller terms are left out. */
const MAX_ALIGNMENT = 10_000;
/** Exponents a double counts exactly; a token beyond them cannot be decided here. */
const MAX_EXPONENT = Number.MAX_SAFE_INTEGER / 2;
/** Significant digits kept when a relative error is turned into a double. */
const RATIO_DIGITS = 20;

function decimalOf(literal: string): Decimal {
  const [units = "0", exponent = "0"] = normalizedDecimal(literal).split("e");
  return { units: BigInt(units), exponent: Number(exponent) };
}

const absoluteUnits = (value: bigint) => (value < 0n ? -value : value);
/** The power of ten just above a nonzero decimal's magnitude. */
const ceilingOrder = (term: Decimal) => term.exponent + absoluteUnits(term.units).toString().length;

/** A positive amount as a double, or undefined when a double cannot show it. */
function asNumber(units: bigint, exponent: number | bigint): number | undefined {
  const number = Number(`${units}e${exponent}`);
  return Number.isFinite(number) && (number !== 0 || units === 0n) ? number : undefined;
}

/**
 * Decides `|after - before| <= absolute + relative × |before|` without rounding, and measures
 * the gap. Undefined when the values are too far apart in scale to align, which counts as a
 * difference.
 */
function measure(
  before: Decimal,
  after: Decimal,
  tolerance: { readonly absolute: number; readonly relative: number },
) {
  const absolute = decimalOf(String(tolerance.absolute));
  const relative = decimalOf(String(tolerance.relative));
  const scaled = {
    units: relative.units * absoluteUnits(before.units),
    exponent: relative.exponent + before.exponent,
  };
  const terms = [before, after, absolute, scaled].filter((term) => term.units !== 0n);
  if (terms.some((term) => Math.abs(term.exponent) > MAX_EXPONENT)) return undefined;
  // Terms below the precision kept are left out; a tie they could break counts as a difference.
  const top = terms.length === 0 ? 0 : Math.max(...terms.map(ceilingOrder));
  const kept = (term: Decimal) => term.units !== 0n && ceilingOrder(term) >= top - MAX_ALIGNMENT;
  const dropped = terms.some((term) => !kept(term));
  const lowest =
    terms.length === 0 ? 0 : Math.min(...terms.filter(kept).map((term) => term.exponent));
  const at = (term: Decimal) =>
    kept(term) ? term.units * 10n ** BigInt(term.exponent - lowest) : 0n;
  const distance = absoluteUnits(at(after) - at(before));
  const limit = at(absolute) + at(scaled);
  if (dropped) return { within: distance < limit, absolute: undefined, relative: undefined };
  return {
    within: distance <= limit,
    absolute: asNumber(distance, lowest),
    relative: (() => {
      if (before.units === 0n) return undefined;
      // Scaled so the quotient keeps its leading digits however the two lengths compare.
      const denominator = absoluteUnits(before.units);
      const shift = Math.max(
        0,
        RATIO_DIGITS + denominator.toString().length - distance.toString().length,
      );
      return asNumber(
        (distance * 10n ** BigInt(shift)) / denominator,
        BigInt(lowest - before.exponent - shift),
      );
    })(),
  };
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
      const bothIntegers = /^-?\d+$/u.test(before.text) && /^-?\d+$/u.test(after.text);
      const measured = measure(decimalOf(before.text), decimalOf(after.text), tolerance);
      absoluteDifference = measured?.absolute;
      relativeDifference = measured?.relative;
      if (
        absoluteDifference !== undefined &&
        (maxAbsoluteError === undefined || absoluteDifference > maxAbsoluteError.error)
      ) {
        maxAbsoluteError = { pointer, error: absoluteDifference };
      }
      if (
        relativeDifference !== undefined &&
        (maxRelativeError === undefined || relativeDifference > maxRelativeError.error)
      ) {
        maxRelativeError = { pointer, error: relativeDifference };
      }
      if (exact || (!bothIntegers && measured?.within === true)) continue;
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
