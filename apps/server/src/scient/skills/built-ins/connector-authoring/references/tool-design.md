# Tool design

Read this when you plan a connector's tools or change them. Agents choose tools by name and
description, call them with what the schema allows, and read every word they return. Good
tools make that easy and cheap.

## Start from the tasks

- Write down the user's two to five real tasks first ("what's due this week in all my
  courses", "find papers citing this one since 2020"). Each tool should finish a task or a
  clear step of one.
- Fewer, fuller tools beat one tool per endpoint. If agents would always call A then B, make
  one tool that does both. Example for a course site: not `list_courses`, `get_course`,
  `list_assignments`, `get_assignment`, but `upcoming_deadlines {days}`,
  `course_materials {course}`, `read_file {file}`.
- Don't make two tools that do nearly the same thing; the agent will pick wrong.
- Reading tools first. Add a tool that changes data only when the user asked for it.

## Names

- `verb_noun` in lowercase with underscores: `search_works`, `get_work`,
  `upcoming_deadlines`. Up to 64 characters, letters, digits and `_` only (the protocol allows
  `-` and `.` too, but some clients don't).
- Scient shows tools as `mcp__<connector>__<tool>`, so the service name need not be in the
  tool name.
- Keep names stable once saved. Skills and habits come to depend on them.

## Descriptions

- One to three sentences, written for a new colleague: what it does, what it returns, when to
  use it instead of its sibling, and any limit ("max 50 per page", "dates in the site's time
  zone, UTC").
- Each parameter gets a description with an example value. Name parameters so they can't be
  misread: `course_id`, not `course`; `from_year`, not `from`.
- Say in the description when a tool changes data: "Submits the assignment on Moodle. This
  changes the user's data: confirm with the user first."
- The server's `instructions` (in `serve(...)`) can hold one or two sentences on how the tools
  fit together.

## Inputs

- Strict schemas: `type: "object"`, `required`, `additionalProperties: false`, `enum` for
  fixed choices, `minimum`/`maximum`, `minLength`/`maxLength`, `default`. `mcp.mjs` checks
  these and tells the agent exactly what was wrong, so it can fix the call.
- Accept the forms people have: a DOI or a doi.org link, a course name or its id. Normalize
  inside the tool.
- One meaning per parameter. No free-form "options" objects.

## Results

- Short and readable. Return the fields that answer the task, with names, not bare ids, but
  keep the id the next tool needs (`id: "W2741809807"` next to the title).
- Ask the API for less where it can (`select=`, `fields=`), drop empty fields, cut long text
  (abstracts, pages) with a note saying it was cut.
- Dates as ISO 8601 (`2026-11-10` or `2026-11-10T14:00:00+02:00`); say the time zone.
- When agents need both a quick view and full detail, add `detail: "short" | "full"` with
  `short` as the default rather than two tools.
- Return plain objects from handlers. `mcp.mjs` sends them as JSON text, and also as
  `structuredContent` when the tool declares an `outputSchema`. The result must match the
  schema: leave a field out rather than send `null` unless the schema allows `null`.
- Size: aim for under ~5,000 words per result. `mcp.mjs` cuts text over 60,000 characters and
  says so, but that is a safety net, not a design.

## Paging

- Take `limit` (a small default such as 10 or 25, a firm maximum such as 50 or 100) and `page`
  or `cursor`.
- Return `total` when the API knows it, `has_more`, and `next_page` or `next_cursor`. Pass the
  API's own cursor back unchanged.
- Never fetch every page in one call unless the total is small and bounded. Say how to narrow
  the search when there are too many results.

## Errors

- Tool errors (`throw new ToolError("…")`, sent with `isError: true`) are for anything the agent
  can act on: bad input, nothing found, rate limited, key rejected, session ended. Each message
  says what happened and what to do next:
  - "No work found for 10.1234/xyz. Check the DOI, or find it with search_works."
  - "OpenAlex is limiting requests; wait 30 s and try again with fewer calls."
  - "The key was refused (401). Call scient_connector_setup with replaceKeys."
- No stack traces, no raw HTML pages, no secrets. Use `safeUrl()` from `http.mjs` for URLs in
  messages, and `snippet()` for a short piece of a body.
- An ended website session is special: its error starts with `SCIENT_SIGN_IN_EXPIRED`
  (`auth-and-sessions.md`). Use it only for a real end of session.
- Protocol errors (unknown tool or method) are handled by `mcp.mjs`.

## Annotations

Hints for the host and the agent, not protection. Set them honestly on every tool:

| Annotation        | Set to `true` when                                               |
| ----------------- | ---------------------------------------------------------------- |
| `readOnlyHint`    | It only reads.                                                   |
| `destructiveHint` | It can delete or overwrite (only meaningful when not read-only). |
| `idempotentHint`  | Calling it twice with the same input has no extra effect.        |
| `openWorldHint`   | It talks to an outside service (almost every connector).         |

Also give each tool a `title` people can read ("Search scholarly works").

## Tools that change data

- Separate tools with plain names (`submit_assignment`, `add_to_collection`), never a `mode`
  switch on a reading tool.
- For risky changes (submit, delete, send, pay), make the default a preview: `confirm: false`
  returns what would happen; `confirm: true` does it. The agent shows the user the preview.
- Never retry a write automatically (`http.mjs` retries only GET and HEAD). After a timeout,
  check whether it happened before trying again.

## State between calls

Avoid it. If a task needs a handle (an upload id, a search session), return it explicitly and
say when it expires; when it has, the error says so and how to start again.

## Before saving

- [ ] Each tool maps to a real task; no near-duplicates.
- [ ] Names, titles, descriptions and parameter descriptions are plain and exact.
- [ ] Schemas are strict; defaults are sensible; limits are stated.
- [ ] Results are short, named, paged, and match their `outputSchema`.
- [ ] Errors say what to do next and hold no secrets.
- [ ] Annotations are honest; writes are separate and say so.
- [ ] `manifest.json` lists the same tools as `server.mjs`.
