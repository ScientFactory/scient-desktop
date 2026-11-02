/**
 * `get_state.usageLimit`: the account is past its usage limit but still being
 * served. No event carries it, so the host reads it when a run ends.
 */
import * as DateTime from "effect/DateTime";
import { isRecord } from "effect-omp-rpc/schema";

const resetClause = (resetsAtSec: unknown): string => {
  if (typeof resetsAtSec !== "number" || !Number.isFinite(resetsAtSec)) return "";
  const time = DateTime.formatLocal(DateTime.makeUnsafe(resetsAtSec * 1000), {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return ` until ${time}`;
};

/** What to tell the user about the limit, or undefined when the account is within it. */
export const ompUsageLimitNotice = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  const until = resetClause(value.resetsAtSec);
  if (value.stage === "wrap_up")
    return `This account passed its usage limit. A short allowance remains${until}${value.extraUsage === true ? ", then extra usage applies" : ""}.`;
  if (value.stage === "low_priority") {
    const left = value.allowanceLeftPercent;
    return `This account passed its usage limit and now runs on spare capacity${until}${typeof left === "number" ? ` (${Math.round(left)}% of the allowance left)` : ""}.`;
  }
  return undefined;
};
