# Design tools around tasks

Build a few tools that return the user's answers, not a catalogue of endpoints. During repairs keep established names, arguments and result fields. Put the task, useful distinctions and limits in the tool descriptions.

Use strict object schemas, bounded strings and arrays, sensible defaults and enums, and keep manifest tools in step with the runtime listing. Return readable names alongside stable IDs, with enough provenance to check identity and version. Dates are ISO-formatted with the source time zone. Results match `outputSchema`, and a missing field is distinct from zero.

For lists, return the total when known, the items returned, the next page or cursor, and truncation or cap information. The last accessible page isn't necessarily the end of the dataset. Pass the service's cursor through unchanged and keep the query parameters. Any cut to authors, abstracts or searches is reported, never hidden behind a claim of completeness.

Return actionable `ToolError` messages built from allowlisted status and error codes, keeping arbitrary service bodies, exceptions and request values out of errors and logs. `safeUrl` masks only recognised query names; it is not a general secret scrubber. The template helpers omit response bodies; keep it that way.

Separate read tools from write tools and set their annotations honestly. The HTTP method alone doesn't show a call is read-only: a search POST can read and a GET can mutate. For consequential writes, offer a preview where the service supports one. Existing authorization for the exact action is enough; ask only about an unapproved change.

After an expiry, timeout or uncertain response to a write, read back its effect instead of retrying; if the outcome can't be established, report it as unknown. The host may replay a request after the sign-in-expired marker whatever the tool's annotations, so emit that marker only where no write could have committed; the template MCP helper emits it only for tools marked read-only. Helpers can't add idempotency the service doesn't guarantee.
