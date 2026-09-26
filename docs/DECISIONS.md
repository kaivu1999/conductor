# Decisions

## What I built

Part 1 end to end, plus the "blocked on a question" extension:

- Create a run from a repo path and a task. It starts in its own worktree on
  `conductor/<id>`, and runs queue past a concurrency cap.
- Status as a state plus a one-line activity derived from tool calls. A "needs
  you" ordering puts the runs that want a decision at the top.
- Review with the agent's summary, a conductor-run test result, and the full diff
  including new files. Accept as a merge that never touches your working copy, or
  keep the branch. Reject cleans up the worktree and branch.
- Restart survival. State lives in SQLite, and a single-instance lock guards the
  data dir. Orphaned agents are killed by process group and env tag, live runs
  become `interrupted` with their session kept, and Restart resumes that session.
  Compare-and-set transitions guarantee a run never starts twice.
- The agent can ask a question and wait for an answer inline. You can also send a
  running agent a steering message.
- Overlap warnings when two live runs touch the same files.
- **Voice.** You can talk to Conductor and do everything the app does: ask what
  needs you, start one or several tasks, answer an agent, steer it, merge, keep a
  branch, reject, cancel, restart, and drive the screen. Conductor is its own persona
  (built by Kaivu). It's full-duplex GPT-Live over WebRTC. A server-side sideband
  hands each request to a Claude orchestrator whose only tools are the supervisor's.
  Merge, reject and cancel need a spoken yes, enforced in code with single-use
  tokens. Tasks that start needing you get a one-line spoken nudge that waits for
  silence.

I verified this against the real agent: two parallel runs on the demo repo, one
accepted and one conflicting, then conductor `kill -9`'d mid-run, restarted, and the
run resumed to a passing result.

Voice was verified against the real GPT-Live API with synthesized speech played in
as the microphone. By voice I started a task, answered its agent's question, merged
it after a spoken yes, and filtered the screen, and heard the notices arrive. A real
microphone and room noise have not been tested yet.

## What I left out, and why

- **Per-action approval.** Agents run with `bypassPermissions` inside the worktree.
  A real gate needs a `PreToolUse` hook that parks the run in `waiting_input`. The
  state machine already has the shape for it; the risk policy is the hard part.
- **Rebase/fix-conflict by the agent.** A conflicted run can be kept as a branch or
  rejected. Sending it back to the agent with "rebase onto main" is a small
  addition but needs a `conflict → queued` path and a fresh test pass.
- **Auth, multi-user, remote access.** Out of scope for single user, single
  machine. The server binds to 127.0.0.1.
- **Log retention and DB compaction.** Events accumulate forever. Fine for weeks of
  personal use.

## With two more days

1. **Voice, second pass.** Barge-in tuning with a real mic, a faster orchestrator
   (answer simple questions from the snapshot without a model turn), and voice
   confirmation for the new approval gate below.
2. **Approval gate** via a `PreToolUse` hook, with a per-repo allowlist, so risky
   commands wait for a yes instead of running.
3. **Agent-driven conflict resolution** and "re-run tests after my edit" on a kept
   branch.
4. **Recording and replaying agent sessions** in tests, so the Claude adapter is
   covered without live calls.

## At 10× the runs, or 10 users

**10× runs (≈40 live).** The bottlenecks are the machine, not conductor: CPU and
RAM for agents and test suites, disk for worktrees (a full checkout each), and API
rate limits. I'd add:

- per-repo concurrency limits and a shared test-run queue,
- sparse or shared-object worktrees (`git worktree` already shares objects; the
  cost is the checkout and `node_modules`),
- cost budgets per repo and per day,
- a smarter attention view. At 40 runs, "needs you" has to rank and batch.

SQLite with WAL is fine at this scale.

**10 users.** This is a different product. It needs authn/z, and runs need an
owner. Agents must stop running as the conductor host user: each run needs a
sandbox (a container or VM per run) with scoped credentials. Repos become remote
clones, not local paths. Accept becomes "open a PR" instead of a local merge. The
store moves to Postgres. The supervisor becomes a worker pool with leases, and the
CAS transition becomes a lease with a heartbeat, so a dead worker's runs get
reclaimed instead of recovered at boot. SSE fan-out goes through a pub/sub. The
state machine, the adapter seam, and the review surface carry over unchanged.
