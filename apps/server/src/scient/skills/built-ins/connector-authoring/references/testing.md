# Testing a connector

Read this before calling a connector done. "It started" and "it answered 200" are not
"it works". It works when an agent, given only its tools, gets the user's real answers from it.

## 1. It starts and lists its tools

`scient_connector_check {folder}` with no calls. It must:

- start without keys or a sign-in, and list every tool (`missing` names what setup still
  needs);
- list the same tools as `manifest.json`, with clear descriptions and strict schemas;
- leave nothing alarming in the log (stderr). Warnings at start are worth reading.

If it fails, the error and log say why; `fixing.md` lists the usual causes.

## 2. Real sample calls

Run calls through `scient_connector_check {folder, connector?, calls}`. Give `connector` once
the connector is saved and set up, so the check uses the user's keys and sign-in.

For each tool, cover:

- **A typical call** from the user's own tasks, with real inputs ("papers on CRISPR base
  editing since 2020", "my deadlines in the next 14 days").
- **The second page**, when it pages: `next_page` or `next_cursor` from the first call works
  and gives different items.
- **An empty answer**: an input with no results comes back as an empty list, not an error.
- **A wrong input**: a bad id or an out-of-range value gives a clear tool error that says what
  to do.
- **The largest realistic answer**: still short enough (a few thousand words at most).

Keep test calls few and read-only. Never call a tool that changes data unless the user asked
for it, on data they chose.

## 3. The data is right

Look at the results, not just the status:

- Compare with the source: the same items the website shows, or a second source (the DOI page,
  the course page). Spot-check three items field by field.
- Counts add up (`total`, page sizes).
- Dates and times are right, with the time zone. Names with accents or non-Latin letters come
  through.
- Nothing is silently dropped: optional fields missing on some items don't break others.
- No secrets in any result or log line (keys, cookies, tokens, file URLs with tokens).

## 4. Sign-ins

For a connector with a website sign-in:

- Without a sign-in, a tool call returns the "no sign-in yet" message, not a crash.
- With the linked sign-in, real calls return the user's data.
- The signed-out shape is recognised: run the tool's request logic against what the site sends
  a signed-out visitor (from your study), and check that it produces the
  `SCIENT_SIGN_IN_EXPIRED` error. Check also that a "no access to this" answer does not.

## 5. A short evaluation

Write three to five questions a researcher would really ask, that:

- need only reading;
- need two or more calls (search, then read; list, then filter);
- have one answer that won't change (a 2019 paper's first author and their institution, not
  "the most cited paper this year").

Solve each one yourself first with the tools, and note the answer. Then, when you can, have a
fresh agent (a subagent with only the connector's tools and the question) try them. Where it
fails or wastes calls, improve the descriptions, the defaults or the results, not the question.
Keep the questions in the connector's `README.md` for the next fix.

## What to tell the user

- What the connector does and its tools, in a line each.
- What you tested: the calls, and one real result in short.
- What you did not test: tools that change data, other computers (say which systems you ran it
  on), anything that needs the person (a captcha).
- What setup is still needed, if any, and how to take it back: Remove on the page of a new
  connector (Remove can be undone), **Undo last change** after a fix.
