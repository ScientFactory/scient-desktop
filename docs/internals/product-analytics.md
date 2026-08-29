# Scient product analytics boundary

Scient has a first-party analytics contract, outbox, worker, and privacy UI. The runtime is disabled
by default: `SCIENT_ANALYTICS_ENABLED` defaults to `false` and consent defaults to `off`. In that
state it creates no worker state and sends nothing.

When an owner deliberately enables the runtime, events still pass through the strict allowlist in
[`packages/scient-analytics/src/contract.ts`](../../packages/scient-analytics/src/contract.ts).
Unknown event names and properties are dropped. Consent level is enforced before queueing, delivery
uses only Scient's first-party gateway, and failures cannot block normal product behavior. The
Settings privacy surface can change consent and request deletion of the installation's analytics
data and anonymous identifier.

## Client presentation metadata

The inherited host now sends bounded client presentation metadata during the authenticated
connection: surface, app version, broad operating-system and device class, web deployment type, and
connection method. The server validates those values and can persist the supported session fields so
connection management can describe current clients. Invalid or unknown values are ignored and never
reject a connection.

Upstream also added `client.connected` and `client.turn.requested` analytics call sites. Those names
are not registered in Scient's analytics contract and are therefore dropped at the Scient boundary.
They must not be documented as collected or used to build a dashboard unless Scient deliberately
adds a reviewed, privacy-bounded contract for them.

## Privacy invariants

Analytics must never include prompts, responses, file contents or paths, URLs, tokens, email
addresses, provider account identifiers, or user-assigned device names. Provider and model values
are normalized into bounded families; unrecognized values collapse to safe categories. New inherited
instrumentation is not automatically authorized by appearing in upstream code: it must either map to
an existing Scient event or be explicitly reviewed and added to the Scient contract.

The detailed current event schema and tests live in `packages/scient-analytics`. Historical design
and capability evidence remains in
[`docs/reports/scient-specific-capabilities.md`](../reports/scient-specific-capabilities.md).
