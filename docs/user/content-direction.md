# Conversation text direction

Scient can control the direction of conversational text without mirroring the
application shell. This is useful when working in Hebrew, Arabic, or another
right-to-left language while code, paths, and the rest of the app remain in
their familiar layout. In **Settings → Appearance → Conversation text
direction**:

- **Automatic** infers a stable direction for each complete message from its
  prose balance and structural blocks. RTL prose makes the message RTL; an
  English-only message is LTR. Paragraphs, lists, and sections use that message
  direction as context when their own language mix is close.
- **Right to left** keeps conversation prose, lists, tables, and the composer
  right-to-left.
- **Left to right** keeps those surfaces left-to-right.

The setting is a local presentation preference. It does not change the text
sent to a provider or the direction of the rest of the application.

While an assistant response is streaming, its base direction stays stable so
the layout does not jump as more text arrives. The completed response is then
resolved from its full content.

Bullet and numbered lists are treated as one group. In Automatic mode, a
mostly English paragraph or list remains LTR even when it contains a Hebrew or
Arabic term. A structure with at least 45% RTL prose becomes RTL; one with at
most 30% stays LTR; a closer mix follows the complete message. List items and
nested lists inherit the group's single direction. Code and equations do not
affect these prose counts. When the whole message is closely mixed, its
paragraphs and structural groups vote once each. An explicit RTL or LTR setting
remains authoritative.

Headings follow the section they introduce. A standalone heading follows its
own prose, while a heading inside a list or table follows that structure's
direction.

Tables keep their existing specialized rule: the dominant prose controls
column order, while each cell keeps its own text flow. A mixed cell becomes LTR
only when at least 70% of its strong characters are LTR. Scientific identifiers
and literal equations do not decide table structure.

The composer uses the same contextual paragraph and list behavior as rendered
messages, so text does not change direction merely because its first word uses
the other script.

Code remains left-to-right so commands, paths, syntax, and source files keep
their normal reading and copying order. A plain-text copy box follows its own
strong script when it is unambiguous; mixed plain text follows the selected
conversation mode (or remains automatic).

In clearly RTL prose, standalone flow arrows are displayed in the reading
direction even when the complete message is LTR. Technical and ambiguous arrow
usage is preserved. An explicitly LTR message never rewrites arrows.
