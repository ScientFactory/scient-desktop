import { questionAnswerMessageId, type OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The provider's sanitized URL is displayed; its launch URL is opened only on a user click. */
export function browserActionPresentation(input: unknown, output: unknown) {
  if (
    input === null ||
    typeof input !== "object" ||
    !("kind" in input) ||
    input.kind !== "open-url"
  ) {
    return undefined;
  }
  const url = "url" in input ? httpUrl(input.url) : undefined;
  if (url === undefined) return undefined;
  const launchUrl = "launchUrl" in input ? httpUrl(input.launchUrl) : undefined;
  return {
    externalUrl: { href: launchUrl ?? url },
    detail: [typeof output === "string" ? output : undefined, url].filter(Boolean).join("\n\n"),
  };
}

/** Imported answers name their own message; native answers use the shared fallback identity. */
export function foldedQuestionAnswerMessageIds(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
) {
  return new Set(
    items.flatMap(({ item }) =>
      item.type === "user_input_request" && item.questionAnswer
        ? [questionAnswerMessageId(item.questionAnswer)]
        : [],
    ),
  );
}
