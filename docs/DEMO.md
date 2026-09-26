# Conductor live demo

About 10 minutes. Three kinds of lines:

- **🗣 You (to the room):** narration for the audience. Say it in your own words.
- **🎙 To Conductor:** say this out loud to the app, word for word is safest.
- **👀 Expect:** what should happen on screen. Point at it.

Pause after each 🎙 line. A reply takes 2–5 seconds and Conductor says "checking"
while it works. Don't repeat yourself; it heard you.

---

## Before you go on

- [ ] `pnpm start`, open it in Chrome, allow the mic. `.env` has `OPENAI_API_KEY` and
      `CONDUCTOR_PROJECTS_DIR=~/kaivu/projects`.
- [ ] Choose the agent:
  - **Real agent:** about 15 minutes before, start two tictactoe runs from the UI,
    "Add night mode" and "Add a score board", so at least one is **Ready** when you start.
  - **Fake agent, predictable timing:** `CONDUCTOR_AGENT=fake pnpm start`. Every run asks
    "Markdown or plain text?" and finishes seconds after you answer.
- [ ] `~/kaivu/projects/weather-app` must not exist yet.
- [ ] Headphones on, so Conductor doesn't hear itself.
- [ ] Close the New run dialog, and have nothing selected (`Esc`).

---

## 1. The problem (1 min)

🗣 **You:** "When you run several coding agents at once, the hard part isn't starting
them, it's knowing which one needs you. Conductor gives each agent its own git
worktree and branch, and sorts everything by what needs you."

👀 **Point at:** the **Needs you** count in the header, and the list grouped
*Needs you / Working / Done*.

🗣 **You:** "Here's a finished one."

👀 **Click** a **Ready** run → the agent's summary, the test result, the full diff.
If two runs touched the same file, point at the overlap warning.

🗣 **You:** "I can do all of this with the mouse. But I'd rather just talk to it."

---

## 2. Talk to it (1 min)

👀 **Press `v`.** The glowing bar rises from the bottom edge.

👀 **Expect:** Conductor speaks first, e.g. *"Heads up, night mode is ready for review."*

🗣 **You:** "It opens by telling me what's waiting, in one line, not a wall of detail."

🎙 **To Conductor:** "What needs me right now?"

👀 **Expect:** a one-sentence summary, e.g. *"Two tasks are ready for review…"*

🗣 **You:** "Watch the colours. Cyan is me talking, violet is it thinking, magenta is
it speaking."

🎙 **To Conductor:** "Tell me more about the night mode one."

👀 **Expect:** it summarizes the changes and tests, and **opens that run on screen**.

🗣 **You:** "It's not just talking about the app, it's driving it."

---

## 3. Start work by voice (1 min)

🎙 **To Conductor:** "Start two tasks in tictactoe: add a move history panel, and add
keyboard controls."

👀 **Expect:** *"Started move history and keyboard controls in tictactoe."* Two new runs
appear and start in parallel.

🗣 **You:** "Two agents, two worktrees, started in one sentence. I said the repo's
name, not a path."

---

## 4. An agent gets stuck (1 min)

🗣 **You:** "Now I'll just wait. When an agent has a question, Conductor won't
interrupt me or read the whole thing out."

👀 **Expect,** once an agent asks (fake agent: within seconds): *"Heads up, keyboard
controls has a question. Want to hear it?"*

🎙 **To Conductor:** "Yes, what's it asking?"

👀 **Expect:** *"It wants to know: Markdown or plain text?"*

🎙 **To Conductor:** "Tell it Markdown."

👀 **Expect:** the run goes from **Needs answer** back to **Running**.

🗣 **You:** "The answer went into that agent's own session. It picks up exactly where
it stopped."

---

## 5. Merging safely (2 min)

🗣 **You:** "Say the review isn't quite what I wanted. I don't have to reject it and start over."

🎙 **To Conductor:** "Tell the night mode one to also add a toggle in the header."

👀 **Expect:** *"Sent night mode back to its agent…"* The run goes from **Ready** to **Running**,
then back to **Ready**, and the diff now includes both changes.

🗣 **You:** "Same agent, same session, same branch. It kept its context and picked up where
it stopped. In the app it's the **Continue** box, or `c`."

🎙 **To Conductor:** "Merge the night mode task."

👀 **Expect:** *"That merges one file into main. Shall I?"*

🗣 **You:** *(before answering)* "Notice it's still **Ready**. Nothing has happened.
Destructive actions need a spoken yes, and that's checked in code, not by the prompt."

🎙 **To Conductor:** "Yes, go ahead."

👀 **Expect:** *"Done, night mode is merged into main."* The run turns **Accepted**.

🗣 **You:** "And if I change my mind…"

🎙 **To Conductor:** "Reject the score board one."

👀 **Expect:** *"Reject score board? Its branch will be deleted."*

🎙 **To Conductor:** "No, wait."

👀 **Expect:** it backs off. The run stays **Ready**.

---

## 6. A brand-new project (1.5 min)

🎙 **To Conductor:** "Start a new project called weather app: a Python CLI that shows
the five-day forecast for a city, with tests."

👀 **Expect:** *"Create a new project called weather app in your projects folder?"*

🗣 **You:** "It repeats the name first, because speech-to-text is bad at names."

🎙 **To Conductor:** "Yes."

👀 **Expect:** `~/kaivu/projects/weather-app` is created as a git repo, and its first run
starts and opens on screen.

🗣 **You:** "A new project gets one first task. If I'd asked for three, it would hold
the other two until this one's merged, so they don't all scaffold the same empty repo."

---

## 7. Handing off to the screen (30 s)

🎙 **To Conductor:** "I'll type the next one myself. Open the new run window for
tictactoe."

👀 **Expect:** the **New run** dialog opens, already pointed at tictactoe, cursor in Task.

🗣 **You:** "When voice is the wrong tool, it hands over to the screen, pre-filled."

👀 **Press `Esc`.**

🎙 **To Conductor:** "Show me only what needs me."

👀 **Expect:** the list filters to runs that need you.

---

## 8. Pop-out (1 min)

👀 **Click** the pop-out icon at the right end of the bar → a small always-on-top window
with a glowing orb.

🗣 **You:** "I don't have to keep this tab open. I can go back to my editor, and
Conductor comes with me."

👀 **Switch** to another app. When a run finishes, the nudge arrives through the orb.

👀 **Close** the pop-out: you're back to the bar, same conversation.

---

## 9. Close (30 s)

🎙 **To Conductor:** "Thanks, that's all for now."

👀 **Press `v`** to end. The bar sinks away.

🗣 **You:** "Under the hood: a realtime voice model does the talking, a Claude agent
with tools over the whole app does the thinking, and the server owns every action
in between. Here's how that fits together." → switch to the architecture write-up.

**Optional resilience beat:** Ctrl-C the server while a run is working, then
`pnpm start` again. The run shows **Interrupted**.

🎙 **To Conductor:** "Restart the keyboard controls task."

👀 **Expect:** it resumes the same agent session.

---

## If something goes wrong

| What happens | What to do |
| --- | --- |
| It misheard a task name | Say it with the repo: "the tictactoe one, keyboard controls". Or "open the new run window". |
| It asks "which one?" | That's by design: it never guesses on an action. Answer with the title. |
| Silence after a command | Give it 5 seconds; it's working. Then "Are you there?" |
| It talks over you, or hears itself | Headphones. `m` mutes your mic. |
| A run is slow (real agent) | Talk through the architecture while it works, or use the fake agent. |
| The bar doesn't appear | Check the mic permission in Chrome's address bar, then press `v` again. |
