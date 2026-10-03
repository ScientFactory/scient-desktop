/**
 * SCIENT-FORK:START — provider service metrics owned by the fork's v1
 * provider service facade.
 *
 * `observability/Metrics.ts` still declares these metric names but no longer
 * exports them, because upstream deleted the only consumer that updated them.
 * The fork keeps `Layers/ProviderService.ts` alive, so the instruments move
 * here with their original names, descriptions, and attribute shaping. The
 * exported names and emitted series are unchanged, so dashboards and the
 * snapshot assertions in `ProviderService.test.ts` keep working.
 *
 * The generic `increment` / `withMetrics` helpers stay in observability and
 * are imported from there; only the provider instruments are fork-owned.
 */
import * as Metric from "effect/Metric";

import {
  compactMetricAttributes,
  normalizeModelMetricLabel,
} from "../../observability/Attributes.ts";

export const providerSessionsTotal = Metric.counter("t3_provider_sessions_total", {
  description: "Total provider session lifecycle operations.",
});

export const providerTurnsTotal = Metric.counter("t3_provider_turns_total", {
  description: "Total provider turn lifecycle operations.",
});

export const providerTurnDuration = Metric.timer("t3_provider_turn_duration", {
  description: "Provider turn request duration.",
});

export const providerRuntimeEventsTotal = Metric.counter("t3_provider_runtime_events_total", {
  description: "Total canonical provider runtime events processed.",
});

export const providerMetricAttributes = (
  provider: string,
  extra?: Readonly<Record<string, unknown>>,
) =>
  compactMetricAttributes({
    provider,
    ...extra,
  });

export const providerTurnMetricAttributes = (input: {
  readonly provider: string;
  readonly model: string | null | undefined;
  readonly extra?: Readonly<Record<string, unknown>>;
}) => {
  const modelFamily = normalizeModelMetricLabel(input.model);
  return compactMetricAttributes({
    provider: input.provider,
    ...(modelFamily ? { modelFamily } : {}),
    ...input.extra,
  });
};
// SCIENT-FORK:END
