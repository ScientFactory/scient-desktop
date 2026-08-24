# Fork a conversation

Use **Fork** beside a sent message or completed response to start a new
conversation from that point. The original conversation is not changed.
Running `/fork` selects the latest completed response.

The confirmation dialog proposes a numbered thread title. Replace it to choose
your own title. If you leave it unchanged, Scient selects the next available
number when it creates the fork. After it opens, you can choose any available
provider and model in the composer before sending the first message.

After a conversation has started, the model picker offers a compact **Fork**
action to continue it with another provider. The fork starts from the latest
completed response, and any unsent text or images move into the new conversation.

**New worktree** is off by default, so the fork uses the current workspace
without rewinding its files. Turn it on to create an isolated worktree at the
selected checkpoint. The switch is unavailable when the project is not a Git
repository or the fork point has no saved checkpoint.

Forking from a completed response keeps the conversation through that response.
Forking from a sent user message keeps the earlier completed conversation and
places the selected message and its images in the new conversation's composer
as an unsent draft.
