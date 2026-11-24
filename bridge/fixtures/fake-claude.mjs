// A stand-in for `claude -p --output-format stream-json`: reads the prompt on stdin and writes
// stream-json lines. FAKE_CLAUDE_SLEEP_MS makes it wait (with a child process that waits too, to
// test that cancel ends the whole tree) before it writes its result.
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const prompt = fs.readFileSync(0, 'utf8')
const sleep = Number(process.env.FAKE_CLAUDE_SLEEP_MS || 0)
const write = (event) => process.stdout.write(JSON.stringify(event) + '\n')

write({ type: 'system', subtype: 'init', session_id: 'sess-1', cwd: process.cwd(), args: process.argv.slice(2) })
write({ type: 'assistant', message: { content: [{ type: 'text', text: `You said: ${prompt}` }] } })
process.stderr.write('a warning\n')

if (sleep > 0) {
  // A grandchild, as Claude Code's Bash tool would start one; its pid goes to a file.
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${sleep})`], { stdio: 'ignore' })
  if (process.env.FAKE_CLAUDE_CHILD_PID_FILE) fs.writeFileSync(process.env.FAKE_CLAUDE_CHILD_PID_FILE, String(child.pid))
  await new Promise((resolve) => setTimeout(resolve, sleep))
}
write({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', num_turns: 1, duration_ms: 1200, total_cost_usd: 0.01 })
