# Study a website without a documented API

Work within the user's requested service and account. Look for official APIs, vendor connectors, exports and feeds before reproducing browser requests. Respect the site's terms, and report a prohibition or an unclear access boundary. Bot protection or a human-only challenge ends the attempt.

Watch the real task with two different inputs. Use `preview_network` request IDs to inspect the responses that carry data, and `preview_evaluate` only to read configuration or replay requests that clearly only read. A POST search can read and a GET can change state, so replay only what you know is safe.

Trace every non-input value to a page, response or cookie, and hold CSRF and session values in memory. Notes and code get endpoints and field names only; HARs, raw page dumps, cookie exports, request captures and private payloads stay out of the project. A masking tool doesn't make private values copyable.

Compare the reading requests with what the page shows: counts, dates and time zones, identifiers, non-Latin names and an empty case. Open a next page and work out its cursor or offset. Implement only fields you have observed or seen documented. Learn the signed-out response shape without deliberately ending the user's session.

Test outside the browser with a folder check and an Accounts sign-in (see `references/auth-and-sessions.md`); the connector itself never posts login forms. Write a small endpoint map in its README: inputs, response shape, token origins without values, expiry signals, the date, and which behaviour is confirmed versus inferred. If only in-browser execution works, report the standalone connector as blocked.
