# Prompt links

A prompt link opens the installed Scient app with a prompt ready to review. Copy one from a
composer or a sent message. The copied link uses the app's registered scheme; it does not put
the prompt on a hosted service. A website must support custom app links to make it clickable.

A link never runs anything. It opens a draft. You read the prompt, then press Send. A link cannot
change your permission mode, branch, or worktree. Your own defaults apply.

## Make a link

Open the command palette and choose **Copy prompt link**. It copies the draft in the composer.
When the project is on GitHub, **Copy prompt link with repo and model** also adds the repository
and the model you picked. Sent messages have a **Copy prompt link** button too.

You can also write a link by hand:

```
scient://new?prompt=Review%20the%20methods
scient://new?prompt=Fix%20the%20build&repo=owner/name&provider=codex&model=gpt-5.5
scient://new?pr=owner/name/123&prompt=Fix%20the%20failing%20check
```

| Parameter  | Meaning                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| `prompt`   | The prompt. Required, except on pull request links. At most 8,000 characters. |
| `repo`     | A GitHub repository, as `owner/name` or its URL.                              |
| `provider` | A provider such as `codex` or `claude`.                                       |
| `model`    | A model of that provider, by its id or name.                                  |
| `pr`       | A GitHub pull request, as `owner/name/123` or its URL.                        |

Encode the prompt for a URL. In JavaScript, use `encodeURIComponent`.

## Open a link

Desktop links use `scient://` (`scient-next-dev://` for a development app). Mobile copies use
the installed binary's existing scheme. Mobile publication remains on hold; this feature does
not change that policy. An explicitly hosted surface can ask whether to open its prompt in
Scient or continue in that connected browser.

- **No `repo`**: the draft opens without a project, on the machine you used last.
- **`repo`**: the draft opens in your most recently used project for that repository. A fork
  counts only for its own owner. When you do not have the repository, choose **Clone** or **Use
  without project**.
- **`provider` and `model`**: used when you have that provider set up. Otherwise your default
  model is used, and Scient tells you.
- **`pr`**: opens the thread linked to that pull request on any connected machine, with the prompt
  in its composer. When no thread is linked, the draft goes on the pull request branch in a new
  worktree. Scient checks the code out only after you confirm, because the checkout runs your
  setup script on it.

A thread link with a prompt, such as `scient://threads/<environment>/<thread>?prompt=…`,
puts the prompt in that thread's composer. If you already typed a draft there, Scient asks
before it replaces it.

Scient removes characters you cannot see, such as zero-width and hidden tag characters, because
they can hide instructions for the agent. When a prompt had them, Scient warns you that it may be
malicious.
