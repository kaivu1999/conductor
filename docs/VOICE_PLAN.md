# Voice layer plan

Status: steps 1–3 of the build order are done (session minting, browser WebRTC,
captions, sideband, orchestrator with read-only tools); steps 4–6 are next. This file is the hand-off for the implementation
session: it covers the architecture, the decisions behind it, the GPT-Live API
facts we depend on, and the build order.

## Goal

**Persona.** The voice is Conductor itself, the conductor of an orchestra of coding
agents, built by Kaivu. It never names the models or companies behind it. Talking to it
should feel like talking to the whole app: anything the UI can do, voice can do, including
screen actions like opening a task or showing only what needs you.

The whole app works by voice: start runs, hear what needs you, answer an agent's
question, accept or reject a change. Notifications are soft. A blocked run gets a
nudge like "About the night-mode task: it's blocked on a question. Want me to read
it?", not the whole blocker read out unprompted.

## Architecture

```
 browser                       conductor server                     OpenAI
 ───────                       ────────────────                     ──────
 mic/speaker ── WebRTC audio ─────────────────────────────────────▶ gpt-live-1
 captions   ◀─ "oai-events" data channel ◀───────────────────────── (same session)
     │
     └ POST /api/voice/session {sdp} ─▶ mint session ─ POST /v1/live/sessions ─▶
                                       │
                                       └ sideband WS  ◀────────────▶ wss://…/attach
                                           │  transcripts, session.delegation.created
                                           ▼
                                       Orchestrator (Claude, tools = supervisor API)
                                           │  start_run / answer / accept / reject …
                                           ▼
                                       Supervisor  ── events ──▶ Notifier ─▶ sideband
```

- **GPT-Live runs the conversation** (full duplex, `gpt-live-1`) with **client
  delegation**. It owns speech, turn-taking, backchannels, and interruptions. It
  never touches conductor state directly.
- **The server owns everything else, over a sideband WebSocket.** The browser
  only carries audio and draws captions. Transcript tracking, delegation handling,
  and notifications all run server-side, so actions happen in one place (the
  docs' "assign one owner for each action"), and the OpenAI key never reaches the
  browser.
- **The orchestrator is a Claude agent** whose only tools wrap the supervisor. It
  gets the recent transcript plus a compact snapshot of the runs, and returns a
  short, speakable result.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Voice model | `gpt-live-1`, not `gpt-realtime` | User asked for the full-duplex model. It also separates talking from thinking: delegation is built in. |
| Delegation mode | client | We need our own agent, our own confirmations, and to vet results before they're spoken. Responses delegation would put OpenAI's model in charge of the tool loop. |
| Where the event logic lives | server sideband (`/v1/live/sessions/{id}/attach`) | One owner per action. Survives browser tab refresh logic. Key stays server-side. Browser stays thin. |
| Orchestrator model | Claude via the existing Agent SDK + auth path, no built-in tools, one in-process MCP server with conductor tools | Reuses the auth and SDK we already run. No file or Bash access, so it cannot bypass the supervisor. |
| Orchestrator memory | one SDK session per voice session (`resume` across delegations) | Handles "yes", "the second one", and "no, Thursday" without resending history. |
| Destructive actions | two-step confirm, enforced in code | `accept_run` / `reject_run` / `cancel_run` first return a confirmation prompt plus a token. The action runs only when it's called again with that token within 60s, after a user "yes" in the transcript. The model can't skip this. |
| Notifications | `thinking.append` carries the details, `commentary.append` carries a one-line nudge | Details are ready when the user says "go on". Nothing long is read out unasked. |
| Notification timing | queue while either side is speaking; flush after ~1.5s of silence; coalesce | Soft means never talking over the user. Several runs at once become "Two tasks need you". |
| What triggers a nudge | transitions into `waiting_input`, `ready`, `failed`, `conflict` (the `needsAttention` states in `shared/attention.ts`) | Same "needs you" definition as the UI list. Running or queued runs stay quiet. |
| Referring to runs | by title or repo, resolved by the orchestrator via `list_runs`; ambiguity → ask | Nobody says "r_7k2m9q" out loud. |

## GPT-Live API facts (from developers.openai.com, fetched 2026-09-26)

Raw docs: `https://developers.openai.com/api/docs/guides/{live,voice-webrtc,live-delegation,live-conversations,live-prompting,voice-server-controls}.md`

**Create the session (server).**
- Request: `POST https://api.openai.com/v1/live/sessions`, header `Authorization: Bearer $OPENAI_API_KEY`.
- Body: `{ session: { model: "gpt-live-1", instructions, delegation: {type:"client"}, audio: {output: {voice: "marin"}} }, transport: { type: "webrtc", sdp: <offer> } }`
- Returns 201: `{ session: {id: "live_…"}, transport: {type: "webrtc", sdp: <answer>} }`
- Omit `audio.format` for WebRTC. Voice is fixed at creation. Creating a WebRTC session bills 15s minimum.

**Browser.**
- `RTCPeerConnection`, add the mic track, and create the `oai-events` data channel before `createOffer`.
- Wait for ICE gathering to complete, then POST the SDP to our server.
- `setRemoteDescription({type: "answer", sdp})`, then wait for `session.started`.
- Do not send `session.start`.

**Sideband (server).**
- Connect to `wss://api.openai.com/v1/live/sessions/{session_id}/attach` with the same Bearer header.
- Don't send `session.start`. The browser still receives events too, so the browser must not act on delegations.

**Transcript.**
- `session.input_transcript.delta` (user) and `session.output_transcript.delta` (assistant) carry `{delta, start_ms, end_ms}`.
- Fragments are not full turns.

**Delegation.**
- `session.delegation.created` carries `{offset_ms, delegation: {id, target: "client"}}` and no task text. Build the request from the transcript.
- Reply with `session.commentary.append {event_id, delegation_id, content}` (spoken, paraphrased) or `session.thinking.append` (quiet context).
- Several updates per delegation are allowed.

**General context.**
- The same append events with `delegation_id: null`.
- `session.instructions.append` changes behavior and can interrupt speech. Use it for the greeting and hard redirects.
- `content` is a plain string of at most 500 tokens.
- Acks (`session.*.appended`) echo `client_event_id`.

**Mute.**
- `session.input_audio.mute` / `unmute` return `session.input_audio.muted` / `unmuted`.
- Muting doesn't stop output.

**Close.**
- Send `session.close`, then wait for `session.closed` (it carries `usage`).
- `session.usage.updated` arrives along the way.

**Prompt template.**
- Keep the headings `Backchannel policy`, `Interruption policy`, and `Delegation policy`. The last has three sub-lists: `Backend tools`, `Delegate to the backend when`, and `Do not delegate to the backend when`.
- End with "Delegate before giving an answer that depends on backend work. Do not guess the result while waiting."

## Orchestrator tools

All tools call the supervisor and store in-process (no HTTP hop):

- `list_runs({filter?})`: id, title, repo, state, one-line activity, attention rank.
- `describe_run({run})`: summary, diff stat, tests, pending question and options, error.
- `start_run({repo, task})` and `fan_out({repo, tasks[]})`. `repo` resolves from recent repos or a path.
- `answer_question({run, answer})` and `message_run({run, text})`.
- `accept_run({run, mode: "merge" | "branch", confirm_token?})`, `reject_run({run, confirm_token?})`, `cancel_run({run, confirm_token?})`.
- `restart_run({run})`.
- Screen: `show_run({run})` opens a task in the UI, `show_needs({on})` toggles the "needs you" filter. Sent to the browser over SSE.

Results are short and factual ("Started 'Add night mode' in tictactoe."). The
orchestrator reports an action as done only after the supervisor confirms it.

## Live instructions (draft)

```
You are Conductor, a calm voice assistant that manages background coding agents.
Speak briefly: one or two sentences. Never read code, diffs, or file lists aloud;
summarize them. Refer to tasks by their short title.

Backchannel policy: Use light backchannels. Do not talk over the user.

Interruption policy: Stop speaking when the user interrupts, and listen.

Delegation policy:
Backend tools:
- Runs: list tasks, describe one, start one or several, answer an agent's question,
  send a message, accept (merge or keep branch), reject, cancel, restart.

Delegate to the backend when:
- The user asks about tasks or asks to change anything.
- The user answers a question you relayed, or says yes/no to a confirmation.

Do not delegate to the backend when:
- The user greets you, or asks you to repeat something already said.
- You need a brief clarification first.

When a notice says a task needs attention, mention it in one short sentence and
offer to go into detail. Do not read the full question unless asked.
Delegate before giving an answer that depends on backend work.
Do not guess the result while waiting.
```

## UI

- A mic button in the header opens the voice session. States: idle, connecting,
  live, muted, closing.
- A mute toggle, `m` as the keyboard shortcut.
- A caption strip showing the last few user and assistant lines.
- The run list highlights the run the orchestrator last acted on.

## Build order

1. `POST /api/voice/session` (mint the session) and the browser WebRTC plus captions. Test: talk and hear it answer.
2. Sideband client plus a transcript buffer, with delegation → an echo stub. Test: it says the stub text.
3. The orchestrator with read-only tools (`list_runs`, `describe_run`). Test: "what needs me?"
4. Action tools plus the confirm tokens. Tests: unit tests for the token rules, then start a run on tictactoe by voice.
5. The notifier: queue, silence gate, coalescing. Tests: unit tests with fake timers, then a live check with a run that calls `ask_user`.
6. Mute, graceful close, usage logging, then the README and DECISIONS updates.

## Risks and open questions

- ~~Node 22's global `WebSocket` may not accept an `Authorization` header.~~ Resolved: undici's
  `new WebSocket(url, { headers })` sends it (checked on Node 22.22), so no `ws` dependency.
- The user's last words can arrive after `session.delegation.created`. The manager waits 400ms
  before reading the transcript; in a live test that captured the whole question.
- Orchestrator latency: Claude with a cold SDK spawn per delegation is slow. Keep one warm streaming session per voice session. GPT-Live keeps talking ("let me check") in the meantime.
- The transcript can mishear run titles. The orchestrator asks when it's unsure and never guesses on a destructive action.
