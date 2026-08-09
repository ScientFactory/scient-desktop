// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- This package owns Scient's local analytics boundary.
import * as NodeCrypto from "node:crypto";

import {
  ANALYTICS_SCHEMA_VERSION,
  ANALYTICS_SOURCE,
  type AnalyticsBatch,
  type AnalyticsConsent,
  type AnalyticsEvent,
  consentAllows,
  type NormalizationContext,
  normalizeInheritedEvent,
} from "./contract.ts";
import { AnalyticsOutbox } from "./outbox.ts";

const DEFAULT_ENDPOINT = "https://events.scientfactory.com/v1/events";
const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_RETRY_MS = 30 * 60 * 1_000;

class DeliveryFailure extends Error {
  readonly errorClass: string;

  constructor(errorClass: string) {
    super(errorClass);
    this.errorClass = errorClass;
  }
}

function deliveryErrorClass(error: unknown): string {
  if (error instanceof DeliveryFailure) return error.errorClass;
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  return "network";
}

export interface AnalyticsRuntimeOptions extends NormalizationContext {
  readonly enabled: boolean;
  readonly consent: AnalyticsConsent;
  readonly outboxPath: string;
  readonly endpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
}

export interface AnalyticsRuntime {
  readonly enabled: boolean;
  readonly record: (name: string, properties?: Readonly<Record<string, unknown>>) => boolean;
  readonly flush: () => Promise<number>;
  readonly setConsent: (consent: AnalyticsConsent) => number;
  readonly pendingCount: () => number;
  readonly close: () => Promise<void>;
}

export function createAnalyticsRuntime(options: AnalyticsRuntimeOptions): AnalyticsRuntime {
  if (!options.enabled || options.consent === "off") {
    return {
      enabled: false,
      record: () => false,
      flush: async () => 0,
      setConsent: () => 0,
      pendingCount: () => 0,
      close: async () => undefined,
    };
  }

  const outbox = new AnalyticsOutbox(options.outboxPath);
  const now = options.now ?? (() => new Date());
  const randomUUID = options.randomUUID ?? NodeCrypto.randomUUID;
  const fetch = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  let consent: AnalyticsConsent = options.consent;
  let closed = false;

  let installationId = outbox.readMeta("installation_id");
  if (!installationId) {
    installationId = `installation:${randomUUID()}`;
    outbox.writeMeta("installation_id", installationId);
  }
  const sessionId = `session:${randomUUID()}`;

  const record: AnalyticsRuntime["record"] = (name, properties) => {
    if (closed) return false;
    const normalized = normalizeInheritedEvent(name, properties, options);
    if (!normalized || !consentAllows(consent, normalized.privacyLevel)) return false;
    if (consent === "off") return false;
    const event: AnalyticsEvent = {
      id: randomUUID(),
      name: normalized.name,
      distinct_id: installationId,
      session_id: sessionId,
      occurred_at: now().toISOString(),
      privacy_level: normalized.privacyLevel,
      consent_level: consent,
      properties: normalized.properties,
    };
    return outbox.enqueue(event);
  };

  const flush: AnalyticsRuntime["flush"] = async () => {
    if (closed) return 0;
    const events = outbox.pending(BATCH_SIZE, now().valueOf());
    if (events.length === 0) return 0;
    const batch: AnalyticsBatch = {
      schema_version: ANALYTICS_SCHEMA_VERSION,
      source: ANALYTICS_SOURCE,
      events: events.map(({ attemptCount: _attemptCount, ...event }) => event),
    };

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new DeliveryFailure(`http-${response.status}`);
      const body = (await response.json().catch(() => {
        throw new DeliveryFailure("invalid-acknowledgement");
      })) as { readonly accepted?: unknown };
      if (body.accepted !== events.length) throw new DeliveryFailure("invalid-acknowledgement");
      outbox.remove(events.map((event) => event.id));
      return events.length;
    } catch (error) {
      const attempt = Math.max(...events.map((event) => event.attemptCount)) + 1;
      const retryDelay = Math.min(MAX_RETRY_MS, 5_000 * 2 ** Math.min(attempt - 1, 8));
      const errorClass = deliveryErrorClass(error);
      outbox.markFailed(
        events.map((event) => event.id),
        errorClass,
        now().valueOf() + retryDelay,
      );
      return 0;
    }
  };

  const setConsent: AnalyticsRuntime["setConsent"] = (nextConsent) => {
    consent = nextConsent;
    return outbox.purgeAbove(nextConsent);
  };

  return {
    enabled: true,
    record,
    flush,
    setConsent,
    pendingCount: () => outbox.size(),
    close: async () => {
      if (closed) return;
      await flush();
      closed = true;
      outbox.close();
    },
  };
}
