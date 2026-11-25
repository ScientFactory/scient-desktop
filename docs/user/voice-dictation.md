# Voice dictation

Scient desktop transcribes a short voice recording with a local model, ChatGPT, or a configured cloud speech engine. You can optionally ask the selected AI provider to correct the
resulting transcript text before Scient inserts or sends it.

1. Select the microphone in the chat composer.
2. On first use, choose a model. Scient suggests a local model for your
   language and offers ChatGPT if you are signed in. A local model is downloaded
   once. You can cancel and resume the download later.
3. Allow microphone access when macOS, Windows, or Linux asks.
4. While recording, choose cancel, insert the transcript, or transcribe and
   send. `Esc` cancels and `Enter` inserts.

If microphone access was denied on macOS, select **Open Settings** beside the
voice error, enable Scient under **Privacy & Security → Microphone**, then quit
and reopen Scient. A downloaded model does not itself grant microphone access.
If the Mac restricts microphone access through parental controls or device
management, those restrictions must be resolved before recording can start.

Dictation continues the current draft without forcing a new line. Existing
spaces and paragraph breaks you entered are preserved. Speech-recognition
segment boundaries do not introduce paragraph breaks.

With a local model, audio and the initial transcript are processed by a bundled
local speech model. Audio remains on the local computer and is never sent to
Scient or an AI provider.

## Dictate with ChatGPT

If Scient Agent or Codex is signed in to ChatGPT, you can dictate with ChatGPT
instead of a local model: choose **ChatGPT** the first time you use the
microphone, or later in **Settings → Voice & Transcription**. Nothing is downloaded, and it
works the same on any computer, however old. Each recording is uploaded with
your ChatGPT sign-in to ChatGPT's own dictation service, the one the ChatGPT and
Codex apps use, and the text comes back to your draft.

Nothing is sent until you choose ChatGPT. With **Automatic** selected under
**Cloud engines → ChatGPT**, Scient uses the chat’s ChatGPT connection when it
can. Otherwise it uses a signed-in Codex connection, or Scient Agent if Codex
is unavailable. You can also select a specific connection. Dictation with
ChatGPT needs an internet connection, and through Scient Agent it needs
version 0.1.9 or newer.

**Clean up** in **Settings → Voice & Transcription** is off by default.
When it remains off, a local model's transcript stays on your computer. When
you turn it on, Scient sends the transcript text—not the recording—to the
selected, authenticated AI provider, together with the selected language when
one is set. While correction is pending, you can use the original transcript
immediately. If the provider is unavailable, unsupported, not authenticated,
times out, or returns an invalid correction, Scient falls back to the exact
original transcript.

To use a cloud speech engine, choose its card in **Settings → Voice & Transcription**.
The card shows where audio goes. Speech keys are managed in **Accounts & secrets**.

Voice dictation is available in the desktop app. The macOS voice runtime
requires macOS 12 or newer. A recording is limited to three minutes. If no
speech is detected, Scient leaves the draft unchanged.

To change models later, open **Settings → Voice & Transcription**. The page shows which model
is recommended for your language, which model is in use, download
progress, and removal controls.

## Record a lesson

Choose **Record a lesson** from a project's menu in the sidebar, or from
**Add** on the Recordings page. Pick the project and microphone, then
**Start recording**.

- Live captions appear while you record. They use the project's
  **Default engine** under **Recordings** for the recording language, and are
  only a preview.
- The audio is saved into the project every second. If Scient closes, the
  recording is recovered the next time it opens.
- **Pause** stops recording until you **Resume**.
- **Stop** saves the recording, transcribes it with the default engine and then
  writes lesson notes: a summary, key concepts and open questions, each with its
  time in the recording. The Recordings page opens on the lesson while this
  runs. A project notes recipe, when set, is used instead of the built-in one.

### Ask a question out loud

Select **Talk** to ask about the lesson while it records. Recording pauses for
the whole conversation, so neither your question nor the answer is recorded.
**End and resume** goes back to recording. Use headphones, so the answer is not
heard by the microphone.

- With Scient Agent signed in to ChatGPT, ChatGPT answers. Your questions go to
  a **Lesson questions** thread in the project, which reads the live captions.
- Otherwise, if you added an OpenAI speech engine under **Cloud engines** and
  allowed audio uploads, OpenAI's realtime model answers with your own key. It
  hears the most recent part of the lesson's captions.

Talk is hidden when neither is set up.

## Recordings defaults

To transcribe a recording, [install FFmpeg](https://ffmpeg.org/download.html)
on the computer running the Scient server, including for cloud transcription.
Put `ffmpeg` and `ffprobe` on that computer's PATH and restart Scient. For a
remote environment, install them on the remote host and restart its server.

Under **Settings → Voice & Transcription → Recordings**, **Default engine** sets
the engine an agent uses when it starts a transcription without choosing one.
Pick the recording language on the left, or choose **Automatic detection** for
jobs that let the engine detect the language. Choose an engine on the right or
leave **Recommended engine** selected. When you start a job from the Recordings
page, choose the engine in the transcription dialog.
Thorough correction still requires an estimate before each job.

For a selected project, enter a notes recipe to generate `notes.md` beside the
completed transcript. An empty recipe leaves automatic notes off. When notes
are enabled, Scient sends the transcript text to the configured correction
model. The original audio stays at its source.

## Cloud speech engines

Under **Cloud engines**, select **Add a provider…**. The picker can use a
sealed bearer key from **Accounts & secrets** or a saved **Custom models**
connection for the provider's exact origin. A connection test sends a short
silent sample. Choose **Use for dictation** to allow that engine to receive
microphone clips and any supported Words hints. Choose a default engine for lessons and meetings separately under **Recordings**.
