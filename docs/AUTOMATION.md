# Always-on AI dev workflows: what actually works

A field guide for getting Claude to brainstorm, build and review around the clock without burning your usage on the same cold start every hour.

## Why scheduled runs feel bad

You set up a routine that runs every few hours. It wakes up knowing nothing, spends a third of its budget re-reading the repo, does something plausible, and forgets all of it before the next run. Three things are missing:

| Missing | Symptom | Fix |
|---|---|---|
| **Memory** | Repeats work, contradicts yesterday's decisions | Keep state in files the agent reads first: a mission, a backlog, a journal |
| **A checker** | Confident, half-finished output | A second agent with fresh context reviews, and a test command gates it |
| **A way to ask** | Guesses at product decisions | A "blocked" queue that a human clears in the morning |

Everything below is some arrangement of those three.

## The four building blocks

**1. State files (free, do this first).** `CLAUDE.md` for rules, a mission file for direction, a backlog of small cards, and an append-only journal. If you already write handover docs by hand at the end of a session, you're doing this manually; the next step is letting the loop write them.

**2. A loop that runs headless Claude.** `claude -p "<prompt>" --output-format stream-json` is the primitive. Anything that orchestrates Claude Code (nightshift, your own script, a GitHub Action) is a loop around that call that decides the prompt, the working directory and what happens with the result.

**3. Isolation.** Every unattended change goes in its own git worktree and branch. Nothing auto-merges into `main`. You review one branch or one PR in the morning instead of auditing a mess.

**4. Separate roles.** One agent plans, one builds, one reviews. Each starts clean with only what it needs. The reviewer never sees the builder's reasoning, only the diff and the card, so it can't be talked into agreeing.

## Pick your setup

### A. Local orchestrator (nightshift): best for "always working" on your own machine

Runs on your logged-in Claude subscription, on your PC, with a live dashboard.

```bash
cd your-repo
npx github:pshen44/nightshift init
# write .nightshift/MISSION.md
npx github:pshen44/nightshift run --forever --test "npm test"
```

- Leave it running with `--forever`; drop cards in from the dashboard (or straight into `board/todo/` from any editor) whenever you think of one.
- When you hit a usage limit it sleeps and resumes, instead of failing.
- Use `haiku` or `sonnet` for the scout and reviewer and save `opus` for the builder. Reviewing a diff doesn't need the biggest model.
- Windows: set the PC to never sleep while plugged in, or the shift sleeps with it.

### B. GitHub-native: best when your PC is off

[`anthropics/claude-code-action`](https://code.claude.com/docs/en/github-actions) runs Claude in GitHub Actions.

- Run `/install-github-app` inside Claude Code to set it up.
- Comment `@claude implement this` on an issue and it opens a PR. Your issues become the backlog.
- Pair it with automatic PR review so every PR (yours, nightshift's, the action's) gets a second opinion.
- Costs API credits or uses a subscription OAuth token, depending on how you authenticate. Check the action's README for the current options.

### C. Claude Code's built-in tools: best for one big job, attended

- **Subagents and workflows** inside a session fan work out in parallel and report back. Great for a large migration or audit you're watching.
- **`/loop`** repeats a prompt in one session, so it keeps its context between iterations.
- **Routines** run on Anthropic's cloud on a schedule. They're fine for small recurring chores (triage new issues, summarize yesterday's commits). They count against your plan's usage and each run starts fresh, so **make the routine's first instruction "read `.nightshift/journal.md` and the backlog" and its last "append what you did to the journal."** That alone fixes most of the zero-context pain.

### D. Agent SDK: when you want to build your own

If you outgrow the above, the Claude Agent SDK gives you the same agent loop as a library (TypeScript or Python). nightshift's `src/shift.js` is a reasonable map of what you'd build: pick work, run an agent in a worktree, gate on tests, review, merge, write memory.

## Spend less usage

1. **Never let an agent rediscover the repo.** A mission file with a map of the codebase saves thousands of tokens per run.
2. **Small cards.** "Add pagination to GET /todos" ships. "Improve the API" wanders.
3. **Cheap gates before expensive ones.** Tests run before the reviewer; a failing test sends the card back without paying for a review.
4. **Cap everything.** Per-agent budget, per-night budget, max cards, max rounds.
5. **Right-size models.** Scout and review on smaller models, build on the big one.
6. **Batch questions.** Blocked cards wait for you instead of retrying a guess all night.

## A morning routine (10 minutes)

1. Open the dashboard. Answer anything in **Needs you**.
2. `git log --oneline main..nightshift` to see what shipped. Skim the cards in `done/`: each has the build notes and the review.
3. Open one PR from `nightshift` into `main`, review it like a teammate's, merge.
4. Add tomorrow's cards. Update `MISSION.md` if priorities changed. That's the steering wheel.

## For Roblox projects

Most Roblox work happens inside Studio, which an unattended agent can't drive reliably (it needs Studio open, rendering, and someone to save). Split the work:

- **Overnight (nightshift):** anything in a Rojo-synced repo: server and client modules, config tables, data and economy logic, and fail-first tests you can run headless (for example with Lune).
- **Attended (you + Claude + the Studio MCP):** building, placing assets, UI authored in Studio, playtests on the device simulator.

Write the rule into `MISSION.md` ("never create Workspace objects from code", "UI is authored in Studio") and the builder will follow it, or file a question instead of breaking it.

## Safety checklist

- [ ] Unattended agents only work in worktrees on their own branches
- [ ] Nothing auto-merges to `main` or auto-deploys
- [ ] Builder tools are an allowlist, not "everything"
- [ ] No secrets in the repo or the prompt; anything needing a credential becomes a question for you
- [ ] Budgets set per agent and per night
- [ ] Full bypass mode only inside a container or VM
