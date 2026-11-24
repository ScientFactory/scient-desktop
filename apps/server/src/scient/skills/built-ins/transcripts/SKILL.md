---
name: transcripts
description: Transcribe project audio, cite a transcript by time, or make timestamped notes from a transcript. For bibliography citations use references.
---

# Transcripts

1. Use `scient_transcription_list` to find existing jobs. For new audio, pass its language when known. If choosing a model, call `scient_transcription_engines` with that language and prefer an installed recommendation. Cloud engines, including ChatGPT, require the machine's **Agents may send audio to cloud engines** permission.
2. Start one job and save its ID. Use `range` in source seconds to transcribe an excerpt. If start returns `busy`, use list and status to check the active job. Wait with `scient_transcription_status` and reuse the ID after a timeout. Use `scient_transcription_cancel` when the user asks to stop.
3. Resume paused or interrupted work by passing its ID as `resume` with the same source, engine, model, language, range, window rule and provider instance. Starting a new job creates a separate revision. Report failure, pause or cancellation before using partial output.
4. Read the returned `transcript.json` or `transcript.md` directly, in slices for long recordings. Use JSON segment bounds for citations and render them as `h:mm:ss–h:mm:ss` in source-audio time. Cite the file or recording with the range so the reader can find the passage.
5. For long recordings, divide consecutive segments into manageable chunks. Draft notes for each chunk in the transcript's language, retaining the time range for every claim. Combine related notes, keep their supporting ranges, and check each final claim against the cited segments. Mark uncertain passages for listening.
6. Write notes in a separate file and leave the transcript text intact. A future correction pipeline will handle transcript edits.
