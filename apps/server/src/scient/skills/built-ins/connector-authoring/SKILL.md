---
name: connector-authoring
description: Connect a service, or build, fix, sign in to or test a Scient connector (MCP server) for a website, API, database, file collection or local program, when existing connectors and Scient tools don't give the access needed or a connector fails or returns wrong data. Use scient-skill-authoring for reusable know-how that needs no new tools.
---

# Connector authoring

Finish with a connector that answers the user's real questions, proven by a real read through the installed connector whose data you compared with the source, or with the exact step that blocked it. Startup and `ok: true` only prove the transport.

Start with what exists: `scient_connector_list` finds installed and catalogue connectors, and `scient_connector_add` adds one that fits. Build only the missing access, and use the user's actual tasks as acceptance cases.

Guardrails: passwords, tokens, cookies and captured sessions stay out of chat, code, manifests and logs; CAPTCHAs, two-factor prompts and bot protection are the user's to pass, never the connector's. A read-only diagnosis inspects status and code and stops there; `scient_connector_check` runs the connector and the calls you give it, so give it only reads.

## Build

1. Read the references the job needs (below). Design a few tools around the user's tasks: strict schemas, bounded outputs, stable identifiers, explicit paging and truncation, writes separate from reads.
2. `scient_connector_copy` gives a working folder (`name` for a new connector, `connector` for an installed local one). Read its README and code, replace the example tools and update the manifest. Scient supplies Node; keep any dependencies inside the folder, since npm may be absent.
3. Test the folder with `scient_connector_check`: startup, the tool list, then sample calls. Read each call's `isError` and `text`, plus `missing`, `error` and `log`, and compare the data with the source. Try a next page, an empty result and bad input where they apply. Done when each tool has a checked result and every page cap or cut field (such as shortened author lists) is written down.
4. For a keyed service, confirm in the folder check that a protected read returns a setup message without the key. For website sign-ins, read `references/auth-and-sessions.md`.
5. Save once with `scient_connector_save`. If the returned connector needs a key, run `scient_connector_setup` for it; if the user closes or declines the card, report where it stopped and leave it closed this turn. Then test one real read with `scient_connector_check` giving `connector` and no `folder`. Report installed, configured and verified as separate states. Persistent rate limits or bot protection end the attempt; report them.

## Repair

A hosted connector has no local code: follow its setup or sign-in status (`scient_connector_control`). For a local one, copy it and read `references/fixing.md`: reproduce the failing read, make the smallest change that keeps its tools' contracts, retest that case and the reads that already worked, and save over that same connector, leaving every other connector as it is.

Read `references/testing.md` before calling it done. Report what the connector does, its tools, a real result you inspected and the gaps, with links to its source. Tell the user they can remove it from its page in **Settings → Extensions** (**Remove**), and after a repair that **Undo last change** is there.

## References

Read with `scient_skill_read_resource` (this skill's name and the path):

- `references/tool-design.md`: schemas, paging, errors and writes.
- `references/auth-and-sessions.md`: keys, website sessions and expiry.
- `references/study-a-website.md`: before building for a site with no documented API.
- `references/science-apis.md`: scholarly APIs and their limits.
- `references/local-tools.md`: local files, databases and command-line tools.
- `references/testing.md`: acceptance and honest completion.
- `references/fixing.md`: diagnosis and repair.
