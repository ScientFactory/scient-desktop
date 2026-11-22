# Repair an installed connector

Read the status and reproduce the failed read before editing. For local code, `scient_connector_copy {connector}` returns the working `folder` and may include `status`, `lastError`, `problem`, `log` and `source`; use `source` to find copied package code when it is present. Work in that folder, not in the app's private store.

`scient_connector_check {folder, connector, calls}` tests with the connector's existing credentials. If the failure doesn't reproduce, say so and keep a suspected fix apart from a demonstrated one. Read the source before replaying any call that could write.

Let the evidence choose the remedy: real entry paths for module errors; the declared .mjs or module format for import errors; folder-local dependencies; setup for missing keys; sign-in for genuine expiry; schema or parser updates for changed data. A 403 or an HTML login-like page alone doesn't prove a key expired. A bot check ends the attempt; report it.

Keep tool names, inputs, outputs and the behaviour that already worked. Done when the failing case and representative reads that already worked both pass. Save with `{folder, connector}` to replace that exact installed connector. A copied vendor package becomes the user's maintained copy; say so, and mention **Undo last change**.

Hosted connectors have no source to repair: use their sign-in or setup remedy, or report the service failure. Restarting or enabling the connector under repair can be part of an authorized fix, not of a check-only review. Leave other connectors as they are, and report a persistent failure rather than cycling sign-ins.
