# Sources

This skill is written in our own words. Its methods draw on these public works, read in
November 2026. No text was copied.

- Anthropic, `mcp-builder` skill (Apache-2.0), github.com/anthropics/skills: phases from plan to
  evaluation, tool naming, pagination fields, annotations, evaluation questions.
- Anthropic, "Writing effective tools for agents", anthropic.com/engineering: few
  workflow-shaped tools, short results with names, actionable errors, improving tools from
  evaluations.
- Model Context Protocol specification 2025-11-25 and 2026-07-28, modelcontextprotocol.io:
  lifecycle, `server/discover`, tools, stdio transport, authorization, elicitation rules.
- MCP Bundle manifest (`.mcpb`), github.com/modelcontextprotocol/mcpb: `user_config`,
  sensitive fields, `${user_config.…}` and `${__dirname}`.
- kalil0321/reverse-api-engineer (MIT): describe the data wanted, check real data rather than a
  200, hand captchas and 2FA to the user, no hard-coded credentials.
- Elenics/har-api-trace (MIT): start capture before sign-in, repeat the action with different
  inputs, replay reading requests only, remove headers one at a time, known hard cases, diff
  endpoint lists when a site changes.
- syall/api-reverse-engineering-toolkit (MIT): look for OpenAPI and GraphQL first, search
  script bundles, mark endpoints confirmed or unverified, never write a field you haven't seen.
- unbrowse-ai/unbrowse (MIT client): drop noise, compare two captures, trace each token to its
  source, success means a verified result, one new sign-in on 401.
- alufers/mitmproxy2swagger (MIT) and jonluca/har-to-openapi (MIT): path templates from
  captures; captures leak secrets.
- Integuru-AI/Integuru (AGPL-3.0, idea only): trace a request's dynamic values back to the
  requests that produce them until only the sign-in cookies remain.
- ChromeDevTools/chrome-devtools-mcp (Apache-2.0): reading request details in the user's own
  signed-in browser.
- Playwright authentication docs and Checkly's TOTP guide: saved browser state holds secrets;
  on expiry, sign in again with stored credentials, then ask the person.
- Service pages for the limits in `science-apis.md`: OpenAlex, NCBI, arXiv, Crossref, Semantic
  Scholar, ClinicalTrials.gov, Zotero, Moodle; and the open-source servers
  cyanheads/pubmed-mcp-server and cyanheads/clinicaltrialsgov-mcp-server (Apache-2.0),
  54yyyu/zotero-mcp and Faixiang/Moodle-MCP (MIT) for field experience.
