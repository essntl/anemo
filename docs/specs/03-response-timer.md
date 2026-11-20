# Prompt: Anemo agent – response timer

I want to see how long the assistant takes: a live timer while it works, and the duration of every finished answer.

## Ground rules

- **Find before you build.** Look up how a reply is started, streamed, stopped and stored, how tool calls are shown, and how approvals and `ask_user` pause a run. Check whether any timing data is recorded already.
- **Keep the code as clean as you found it.** Follow the existing structure and conventions; don't change unrelated behaviour.
- **Tests** for every "Done when" point; run the whole suite before each commit.

## Build

### 1. The server is the clock

- The server records when it accepted my message (`started_at`), when the reply ended (`finished_at`) and how it ended: done, stopped or failed.
- It also records the time spent waiting for me (approvals, `ask_user`), and the start and end of every tool call.
- The UI calculates the elapsed time from the server's `started_at`, corrected for the difference between the server's clock and the browser's. Never start the timer from the browser's click. That way a reload, a second tab or another device shows the right time.
- The timing is stored with the message, so it survives reloads. Old messages without timing data show nothing.

### 2. Live timer while it works

- Next to the working indicator of the current reply: the elapsed time, counting up every second.
- While the run waits for my approval or my answer, the timer pauses and shows "waiting for you".
- A running tool call shows its own live counter in its block.

### 3. After the reply

- A small, quiet duration on the message, e.g. "41 s" or "2 m 05 s". Stopped and failed replies get one too, marked as such.
- Hovering or clicking shows the details: total, time to first text, time waiting for me (not part of the total), number of tool calls.
- Each tool call block shows how long it took, sub-agent calls included.

### 4. Format

Under a minute `42 s`, under an hour `2 m 05 s`, longer `1 h 03 m`. The live timer uses the same format.

### 5. Automation runs

Runs record the same timing. Showing it in the Automations run log belongs to the automations work; just make the data available.

### 6. Performance

The tick re-renders only the timer element, once per second, never the message list. Streaming must not get slower in a long chat. Clear every interval when the reply ends or the chat closes.

## Done when

- The live timer starts at the server's `started_at`, and the final duration matches the server's record within a second.
- Reloading the page in the middle of a reply shows the correct elapsed time, not zero.
- While a run waits for approval, the timer shows "waiting for you", and that time isn't counted in the total.
- Stopped and failed replies get a duration, marked as stopped or failed.
- Every tool call shows its duration, and a running one counts live.
- Old messages without timing data show nothing, and nothing breaks.
- In a long chat, a tick re-renders only the timer (check with the React profiler or a render-count test).
- Report: what you built, what you didn't, every design decision and why.
