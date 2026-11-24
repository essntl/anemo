// node --test bridge/   (Node 18+). Runs on Windows, macOS and Linux with a fake Claude Code.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BridgeError,
  JOB_ID,
  cancelJob,
  claudeArgs,
  config,
  isAlive,
  jobState,
  localIso,
  main,
  newJobId,
  parseArgs,
  readMeta,
  resolveProject,
  startJob,
} from './cc.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const FAKE = path.join(here, 'fixtures', 'fake-claude.mjs')
let root
let cfg

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'anemo-bridge-'))
  cfg = config({ ANEMO_DEV_ROOT: path.join(root, 'dev'), ANEMO_JOBS_DIR: path.join(root, 'jobs'), ANEMO_CLAUDE: FAKE, ANEMO_GITHUB_OWNER: 'nobody' })
  fs.mkdirSync(path.join(cfg.devRoot, 'anemo'), { recursive: true })
  fs.mkdirSync(path.join(cfg.devRoot, 'my-site'), { recursive: true })
  fs.mkdirSync(path.join(cfg.devRoot, 'my-shop'), { recursive: true })
})

after(() => fs.rmSync(root, { recursive: true, force: true }))

async function until(check, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail('timed out')
}

test('job ids have the contract format', () => {
  const id = newJobId(new Date(2026, 10, 24, 9, 5, 7))
  assert.match(id, /^20261124-090507-[a-z0-9]{4}$/)
  assert.match(id, JOB_ID)
})

test('started is ISO 8601 with the local offset', () => {
  assert.match(localIso(new Date()), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
})

test('the default folders are per system', () => {
  const plain = config({})
  if (process.platform === 'win32') {
    assert.equal(plain.devRoot, 'C:\\dev')
    assert.equal(plain.jobsDir, 'C:\\anemo-bridge\\jobs')
  } else {
    assert.equal(plain.devRoot, path.join(os.homedir(), 'dev'))
    assert.equal(plain.jobsDir, path.join(os.homedir(), 'anemo-bridge', 'jobs'))
  }
})

test('claude gets the same arguments as from Anemo Desktop, values checked', () => {
  assert.deepEqual(claudeArgs({}), ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'])
  assert.deepEqual(claudeArgs({ resume: 's-1', model: 'opus', maxTurns: 5 }).slice(6), ['--resume', 's-1', '--model', 'opus', '--max-turns', '5'])
  assert.throws(() => claudeArgs({ model: 'opus; rm -rf /' }), BridgeError)
  assert.throws(() => claudeArgs({ resume: 'a b' }), BridgeError)
  assert.throws(() => claudeArgs({ maxTurns: 501 }), BridgeError)
})

test('the command line is parsed', () => {
  assert.deepEqual(parseArgs(['start', '--project', 'x', '--new', '--max-turns', '3']), {
    command: 'start',
    options: { project: 'x', new: true, maxTurns: '3' },
  })
  assert.throws(() => parseArgs(['start', 'stray']), BridgeError)
})

test('projects resolve as in cc.ps1', () => {
  const none = () => []
  assert.equal(resolveProject(cfg, 'Anemo', false, none), path.join(cfg.devRoot, 'anemo'))
  assert.equal(resolveProject(cfg, 'site', false, none), path.join(cfg.devRoot, 'my-site'))
  assert.throws(() => resolveProject(cfg, 'my', false, none), /Several local projects match/)
  assert.throws(() => resolveProject(cfg, 'nothing-like-it', false, none), /No project matches/)
  assert.throws(() => resolveProject(cfg, '..', true, none), BridgeError)
})

test('a job is started detached in the folder format and ends done', async () => {
  const dir = path.join(cfg.devRoot, 'anemo')
  const job = startJob(cfg, { prompt: 'Grüße, list the files', dir, model: 'opus' })

  assert.match(job.id, JOB_ID)
  const files = fs.readdirSync(job.jobDir).sort()
  assert.deepEqual(files, ['err.txt', 'meta.json', 'out.jsonl', 'prompt.txt'])
  assert.equal(fs.readFileSync(path.join(job.jobDir, 'prompt.txt'), 'utf8'), 'Grüße, list the files')
  const meta = readMeta(job.jobDir)
  assert.deepEqual(Object.keys(meta), ['id', 'pid', 'dir', 'resume', 'started', 'prompt_preview', 'model'])
  assert.equal(meta.id, job.id)
  assert.equal(meta.pid, job.pid)
  assert.equal(meta.dir, dir)
  assert.equal(meta.model, 'opus')

  await until(() => jobState(job.jobDir).state === 'done')
  const state = jobState(job.jobDir)
  assert.equal(state.session_id, 'sess-1')
  assert.equal(state.result.result, 'Done.')
  const init = state.events[0]
  assert.equal(fs.realpathSync(init.cwd), fs.realpathSync(dir)) // it ran in the project folder
  assert.deepEqual(init.args.slice(-2), ['--model', 'opus'])
  assert.equal(fs.readFileSync(path.join(job.jobDir, 'err.txt'), 'utf8'), 'a warning\n')

  const lines = []
  await main(['status', '--id', job.id], cfg, (l) => lines.push(l))
  assert.match(lines.join('\n'), /state: done[\s\S]*--- result ---\nDone\./)
  lines.length = 0
  await main(['list'], cfg, (l) => lines.push(l))
  assert.ok(lines.some((l) => l.startsWith(job.id) && l.includes('done')))
  lines.length = 0
  await main(['log', '--id', job.id], cfg, (l) => lines.push(l))
  assert.ok(lines.some((l) => l.startsWith('AI: You said: Grüße')))
  assert.equal((await cancelJob(cfg, job.id)), 'done') // already ended: nothing to cancel
})

test('cancel writes the marker and ends the whole process tree', async () => {
  const pidFile = path.join(root, 'child.pid')
  process.env.FAKE_CLAUDE_SLEEP_MS = '60000'
  process.env.FAKE_CLAUDE_CHILD_PID_FILE = pidFile
  let job
  try {
    job = startJob(cfg, { prompt: 'take your time', dir: path.join(cfg.devRoot, 'anemo') })
  } finally {
    delete process.env.FAKE_CLAUDE_SLEEP_MS
    delete process.env.FAKE_CLAUDE_CHILD_PID_FILE
  }
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0)
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.equal(jobState(job.jobDir).state, 'running')

  assert.equal(await cancelJob(cfg, job.id), 'cancelled')

  assert.ok(fs.existsSync(path.join(job.jobDir, 'cancelled')))
  await until(() => !isAlive(job.pid) && !isAlive(grandchild))
  assert.equal(jobState(job.jobDir).state, 'cancelled')
})

test('bad ids are refused', async () => {
  await assert.rejects(main(['status', '--id', '../etc'], cfg, () => {}), /not a job id/)
  await assert.rejects(main(['cancel', '--id', '20261124-101500-zzzz'], cfg, () => {}), /There is no job/)
})
