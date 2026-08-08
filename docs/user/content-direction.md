# Conversation text direction

Scient can control the direction of conversational text without mirroring the
application shell. In Settings → Appearance → Conversation text direction:

- **Automatic** infers a stable direction for each complete message. RTL prose
  makes the message RTL; an English-only message is LTR.
- **Right to left** keeps conversation prose, lists, tables, and the composer
  right-to-left.
- **Left to right** keeps those surfaces left-to-right.

The setting is a local presentation preference. It does not change the text
sent to a provider or the direction of the rest of the application.

While an assistant response is streaming, its base direction stays stable so
the layout does not jump as more text arrives. The completed response is then
resolved from its full content.

Bullet and numbered lists are treated as one group. In Automatic mode, any RTL
prose in the list makes the whole list RTL; an English-only list is LTR, and
items (including nested lists) inherit that group direction. An explicit RTL or
LTR setting remains authoritative for the complete list.

Tables follow the same whole-group rule: Hebrew content makes the table RTL,
while an English-only table remains LTR even inside an RTL message.

Code remains left-to-right so commands, paths, syntax, and source files keep
their normal reading and copying order. A plain-text copy box follows its own
strong script when it is unambiguous; mixed plain text follows the selected
conversation mode (or remains automatic).
