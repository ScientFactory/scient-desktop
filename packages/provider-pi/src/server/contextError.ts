/** Keep model limits distinct from rate limits and transient service failures. */
export function piContextErrorMessage(message: string): string {
  if (/rate.?limit|too many requests|throttl/iu.test(message)) return message;
  if (
    !/context.{0,30}(?:length|window|limit|overflow)|prompt is too long|input.{0,30}(?:too long|exceed)|maximum prompt length|too many tokens/iu.test(
      message,
    )
  )
    return message;
  return "Pi reached this model's context limit. Saved messages and completed tool results are intact. Compact this conversation and then continue, or choose a larger-context model.";
}
