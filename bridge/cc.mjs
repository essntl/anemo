#!/usr/bin/env node
// Anemo <-> Claude Code bridge, for Windows, macOS and Linux (Node 18 or later, no packages).
// It does what C:\anemo-bridge\cc.ps1 does, in the same job-folder format, so a job started
// here shows on Anemo's Code page like one Anemo Desktop starts (docs/device-contracts.md §7,
// docs/specs/09-desktop-macos.md D6). Anemo agents call it over computer_shell.
//
//   node cc.mjs projects [--remote]          local projects (branch, changes, last commit, remote);
//                                            --remote adds GitHub repositories not cloned yet
//   node cc.mjs resolve --project <name> [--new]
//   node cc.mjs start   --project <name> --prompt "..." [--prompt-file f] [--new] [--dir d]
//                       [--resume <session>] [--model <m>] [--max-turns N]
//   node cc.mjs status  --id <job>
//   node cc.mjs log     --id <job> [--tail 30]
//   node cc.mjs list
//   node cc.mjs cancel  --id <job>
//
// Folders: ANEMO_DEV_ROOT and ANEMO_JOBS_DIR, else C:\dev and C:\anemo-bridge\jobs on Windows,
// ~/dev and ~/anemo-bridge/jobs elsewhere. GitHub owner: ANEMO_GITHUB_OWNER, else the account
// gh is signed in as. Claude Code: ANEMO_CLAUDE, else `claude` on PATH (and ~/.local/bin).
//
// How --project is found (case, spaces, - _ . ignored), as in cc.ps1:
//   1. a folder in the projects folder with that name, or whose git remote has that name
//   2. otherwise one unique partial match among local folders
//   3. otherwise the owner's GitHub repository of that name (or one unique partial match),
//      cloned into the projects folder
//   4. otherwise, only with --new: an empty folder with git init
// Several matches: an error listing them. --dir <path> skips all this.

import { spawn, spawnSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const IS_WINDOWS = process.platform === 'win32'
export const JOB_ID = /^\d{8}-\d{6}-[A-Za-z0-9]{4}$/
const SESSION = /^[A-Za-z0-9-]{1,100}$/
const MODEL = /^[A-Za-z0-9._[\]-]{1,100}$/
const PREVIEW_CHARS = 200
// A process that started later than this after the job did is another program with the same pid.
const PID_REUSE_SLACK_MS = 60_000

/** The folders and names this run uses, from the environment (tests set their own). */
export function config(env = process.env) {
  const home = os.homedir()
  return {
    devRoot: env.ANEMO_DEV_ROOT || (IS_WINDOWS ? 'C:\\dev' : path.join(home, 'dev')),
    jobsDir: env.ANEMO_JOBS_DIR || (IS_WINDOWS ? 'C:\\anemo-bridge\\jobs' : path.join(home, 'anemo-bridge', 'jobs')),
    owner: env.ANEMO_GITHUB_OWNER || null,
    claude: env.ANEMO_CLAUDE || null,
    home,
  }
}

export class BridgeError extends Error {}

// -- small helpers -------------------------------------------------------------------------

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const short = (text, n) => String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, n)
const pad = (n, width = 2) => String(n).padStart(width, '0')

/** A command's output, or '' when it failed or isn't installed. Never through a shell. */
function run(program, args, cwd) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
  })
  return result.status === 0 ? result.stdout.trim() : ''
}

/** The full path of a program on PATH (with PATHEXT on Windows), or null. Relative PATH entries are skipped. */
export function findOnPath(program, env = process.env, extraDirs = []) {
  const dirs = [...(env.PATH || env.Path || '').split(path.delimiter), ...extraDirs]
  const exts = IS_WINDOWS ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : ['']
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue
    for (const ext of exts) {
      const candidate = path.join(dir, program + ext.toLowerCase())
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        // not there
      }
    }
  }
  return null
}

/** Claude Code's full path: ANEMO_CLAUDE, else where its installers put it, else PATH. */
export function findClaude(cfg) {
  if (cfg.claude) return cfg.claude
  const local = path.join(cfg.home, '.local', 'bin', IS_WINDOWS ? 'claude.exe' : 'claude')
  if (fs.existsSync(local)) return local
  const found = findOnPath('claude', process.env, IS_WINDOWS ? [] : [path.join(cfg.home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'])
  if (!found) throw new BridgeError("Claude Code (claude) isn't on PATH; set ANEMO_CLAUDE to its full path")
  return found
}

/** A new job id: local time and 4 random lowercase letters or digits (20261124-101500-ab12). */
export function newJobId(now = new Date()) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const suffix = Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${date}-${time}-${suffix}`
}

/** ISO 8601 with the local offset, as meta.json's `started` (2026-11-24T10:15:00.123+01:00). */
export function localIso(now = new Date()) {
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  const base = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
  return `${base}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

function writeJsonAtomic(file, value) {
  const temp = file + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(temp, file)
}

// -- projects ------------------------------------------------------------------------------

export function localProjects(cfg) {
  if (!fs.existsSync(cfg.devRoot)) return []
  return fs
    .readdirSync(cfg.devRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(cfg.devRoot, d.name)
      const remote = run('git', ['-C', dir, 'remote', 'get-url', 'origin'])
      const repo = remote ? remote.replace(/\.git$/, '').split(/[/:]/).pop() : ''
      return { name: d.name, path: dir, remote, repo }
    })
}

function owner(cfg) {
  return cfg.owner || run('gh', ['api', 'user', '--jq', '.login']) || null
}

function githubRepos(cfg) {
  const who = owner(cfg)
  if (!who) return []
  const out = run('gh', ['repo', 'list', who, '--limit', '300', '--json', 'name,isPrivate,description'])
  try {
    return out ? JSON.parse(out) : []
  } catch {
    return []
  }
}

/** The folder a project name stands for (cloning or making it when needed); throws with the reason. */
export function resolveProject(cfg, name, allowNew, repos = () => githubRepos(cfg)) {
  const n = norm(name || '')
  if (!n) throw new BridgeError('The project name is empty')
  const local = localProjects(cfg)
  const matches = (p, test) => test(norm(p.name)) || (p.repo && test(norm(p.repo)))
  const exact = local.filter((p) => matches(p, (x) => x === n))
  if (exact.length === 1) return exact[0].path
  if (exact.length > 1) throw new BridgeError(`Several local projects match '${name}': ${exact.map((p) => p.name).join(', ')}`)
  const part = local.filter((p) => matches(p, (x) => x.includes(n)))
  if (part.length === 1) return part[0].path
  if (part.length > 1) throw new BridgeError(`Several local projects match '${name}': ${part.map((p) => p.name).join(', ')}. Use the exact name.`)

  const remote = repos()
  let hit = remote.filter((r) => norm(r.name) === n)
  if (hit.length === 0) hit = remote.filter((r) => norm(r.name).includes(n))
  if (hit.length > 1) throw new BridgeError(`Several GitHub repos match '${name}': ${hit.map((r) => r.name).join(', ')}. Use the exact name.`)
  if (hit.length === 1) {
    const who = owner(cfg)
    const dest = path.join(cfg.devRoot, hit[0].name)
    fs.mkdirSync(cfg.devRoot, { recursive: true })
    const cloned = spawnSync('gh', ['repo', 'clone', `${who}/${hit[0].name}`, dest], { stdio: 'ignore', windowsHide: true })
    if (cloned.status !== 0) throw new BridgeError(`Cloning ${who}/${hit[0].name} failed`)
    console.log(`cloned ${who}/${hit[0].name} -> ${dest}`)
    return dest
  }
  if (allowNew) {
    const folder = name.trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-')
    if (!/^[A-Za-z0-9._-]+$/.test(folder) || /^\.+$/.test(folder)) throw new BridgeError(`'${name}' can't be a folder name`)
    const dest = path.join(cfg.devRoot, folder)
    fs.mkdirSync(dest, { recursive: true })
    spawnSync('git', ['-C', dest, 'init', '-q'], { stdio: 'ignore', windowsHide: true })
    console.log(`created new project ${dest} (git init, no remote yet)`)
    return dest
  }
  throw new BridgeError(`No project matches '${name}'. Local: ${local.map((p) => p.name).join(', ')}. Pass --new to create it.`)
}

// -- starting a job ------------------------------------------------------------------------

/** Claude Code's arguments for a job (the prompt goes on stdin, never here). */
export function claudeArgs({ resume, model, maxTurns }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']
  if (resume) {
    if (!SESSION.test(resume)) throw new BridgeError('--resume must be a Claude Code session id')
    args.push('--resume', resume)
  }
  if (model) {
    if (!MODEL.test(model)) throw new BridgeError('--model must be a model name (letters, digits, . _ - [ ])')
    args.push('--model', model)
  }
  if (maxTurns) {
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 500) throw new BridgeError('--max-turns must be 1 to 500')
    args.push('--max-turns', String(maxTurns))
  }
  return args
}

/**
 * The program and arguments that run Claude Code: a JavaScript file through this Node, a
 * .cmd on Windows through cmd.exe (Node refuses to start one directly), else itself.
 */
function commandFor(claude, args) {
  if (/\.(mjs|cjs|js)$/i.test(claude)) return { file: process.execPath, args: [claude, ...args], verbatim: false }
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(claude)) {
    if (/["%\r\n]/.test(claude)) throw new BridgeError("Claude Code's path has a \" or % in it, which cmd.exe can't carry")
    // The arguments are validated tokens without spaces or quotes (claudeArgs).
    return { file: 'cmd.exe', args: ['/d', '/v:off', '/s', '/c', `""${claude}" ${args.join(' ')}"`], verbatim: true }
  }
  return { file: claude, args, verbatim: false }
}

/**
 * Starts a job: a new folder with prompt.txt, Claude Code started detached in `dir` with
 * prompt.txt as stdin and out.jsonl / err.txt as stdout / stderr, then meta.json with its pid.
 * Detached means its own session and process group on macOS and Linux (setsid), and its own
 * hidden process on Windows: it outlives this script, and cancel ends its whole tree.
 */
export function startJob(cfg, { prompt, dir, resume = null, model = null, maxTurns = 0, now = new Date() }) {
  if (!prompt) throw new BridgeError('Give --prompt or --prompt-file')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const args = claudeArgs({ resume, model, maxTurns })
  const claude = findClaude(cfg)
  fs.mkdirSync(cfg.jobsDir, { recursive: true })
  let id
  let jobDir
  for (let attempt = 0; ; attempt++) {
    id = newJobId(now)
    jobDir = path.join(cfg.jobsDir, id)
    try {
      fs.mkdirSync(jobDir)
      break
    } catch (e) {
      if (e.code !== 'EEXIST' || attempt > 50) throw e
    }
  }
  const promptFile = path.join(jobDir, 'prompt.txt')
  fs.writeFileSync(promptFile, prompt, 'utf8')
  const stdin = fs.openSync(promptFile, 'r')
  const stdout = fs.openSync(path.join(jobDir, 'out.jsonl'), 'w')
  const stderr = fs.openSync(path.join(jobDir, 'err.txt'), 'w')
  const started = localIso(new Date())
  let child
  try {
    const command = commandFor(claude, args)
    child = spawn(command.file, command.args, {
      cwd: dir,
      detached: true,
      stdio: [stdin, stdout, stderr],
      windowsHide: true,
      windowsVerbatimArguments: command.verbatim,
      env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' },
    })
  } finally {
    fs.closeSync(stdin)
    fs.closeSync(stdout)
    fs.closeSync(stderr)
  }
  if (!child.pid) throw new BridgeError('Claude Code did not start')
  child.unref()
  writeJsonAtomic(path.join(jobDir, 'meta.json'), {
    id,
    pid: child.pid,
    dir,
    resume,
    started,
    prompt_preview: short(prompt, PREVIEW_CHARS),
    model,
  })
  return { id, pid: child.pid, dir, jobDir }
}

// -- reading a job -------------------------------------------------------------------------

export function readMeta(jobDir) {
  const text = fs.readFileSync(path.join(jobDir, 'meta.json'), 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(text)
}

export function readEvents(jobDir) {
  const file = path.join(jobDir, 'out.jsonl')
  if (!fs.existsSync(file)) return []
  const events = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event && typeof event === 'object') events.push(event)
    } catch {
      // not JSON: Claude Code wrote a plain line
    }
  }
  return events
}

/** Whether the process lives (signal 0 checks without sending anything). */
export function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM' // it exists, as another user's
  }
}

/** When the process started (macOS/Linux, from ps), or null when that can't be read. */
function processStart(pid) {
  if (IS_WINDOWS) return null
  const out = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  const when = Date.parse((out.stdout || '').trim())
  return Number.isNaN(when) ? null : when
}

/** The job's process, if it still runs and is the job's (not another program that got the pid). */
function jobProcessAlive(meta) {
  if (!isAlive(meta.pid)) return false
  const startedAt = processStart(meta.pid)
  const jobStarted = Date.parse(meta.started)
  return startedAt === null || Number.isNaN(jobStarted) || startedAt <= jobStarted + PID_REUSE_SLACK_MS
}

/** The state, by the rules of device-contracts.md §7.2. */
export function jobState(jobDir) {
  const meta = readMeta(jobDir)
  const events = readEvents(jobDir)
  const result = events.filter((e) => e.type === 'result').pop() || null
  const session = events.find((e) => e.session_id)?.session_id || null
  let state
  if (fs.existsSync(path.join(jobDir, 'cancelled'))) state = 'cancelled'
  else if (result) state = result.is_error || (result.subtype && result.subtype !== 'success') ? 'failed' : 'done'
  else if (jobProcessAlive(meta)) state = 'running'
  else state = 'exited_without_result'
  return { id: meta.id, state, dir: meta.dir, started: meta.started, pid: meta.pid, session_id: session, prompt: meta.prompt_preview, result, events }
}

export function formatEvent(e) {
  const lines = []
  if (e.type === 'assistant') {
    for (const c of e.message?.content || []) {
      if (c.type === 'text' && c.text?.trim()) lines.push('AI: ' + short(c.text, 300))
      else if (c.type === 'tool_use') lines.push(`TOOL ${c.name}: ` + short(JSON.stringify(c.input), 200))
    }
  } else if (e.type === 'user') {
    for (const c of e.message?.content || []) {
      if (c.type === 'tool_result' && c.is_error) lines.push('TOOL ERROR: ' + short(typeof c.content === 'string' ? c.content : JSON.stringify(c.content), 200))
    }
  } else if (e.type === 'result') {
    lines.push(`RESULT (${e.subtype}, ${Math.round((e.duration_ms || 0) / 1000)}s, ${e.num_turns} turns, cost ${e.total_cost_usd} USD)`)
  }
  return lines
}

function jobDirOf(cfg, id) {
  if (!JOB_ID.test(id || '')) throw new BridgeError(`'${id}' is not a job id like 20261124-101500-ab12`)
  const dir = path.join(cfg.jobsDir, id)
  if (!fs.existsSync(dir)) throw new BridgeError(`There is no job ${id}`)
  return dir
}

// -- cancelling ----------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Ends the process and everything it started: taskkill /T on Windows, its process group elsewhere. */
export async function killTree(pid) {
  if (IS_WINDOWS) {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  const signal = (sig) => {
    try {
      process.kill(-pid, sig) // the whole group: the job leads it (setsid)
      return true
    } catch {
      try {
        process.kill(pid, sig) // not a group leader (started by something else)
        return true
      } catch {
        return false
      }
    }
  }
  if (!signal('SIGTERM')) return
  for (let i = 0; i < 30; i++) {
    await sleep(100)
    if (!groupAlive(pid)) return
  }
  signal('SIGKILL')
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return isAlive(pid)
  }
}

/** Writes `cancelled` first (so the job never looks as if it ended by itself), then ends the tree. */
export async function cancelJob(cfg, id) {
  const jobDir = jobDirOf(cfg, id)
  const before = jobState(jobDir)
  if (before.state !== 'running') return before.state
  fs.writeFileSync(path.join(jobDir, 'cancelled'), '')
  await killTree(before.pid)
  return 'cancelled'
}

// -- the command line ----------------------------------------------------------------------

export function parseArgs(argv) {
  const [command = 'list', ...rest] = argv
  const options = {}
  for (let i = 0; i < rest.length; i++) {
    const m = /^--?([a-z][a-z-]*)$/i.exec(rest[i])
    if (!m) throw new BridgeError(`Unexpected '${rest[i]}'`)
    const key = m[1].toLowerCase().replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (['new', 'remote'].includes(key)) options[key] = true
    else if (i + 1 < rest.length) options[key] = rest[++i]
    else throw new BridgeError(`--${m[1]} needs a value`)
  }
  return { command, options }
}

export async function main(argv, cfg = config(), out = (line) => console.log(line)) {
  const { command, options } = parseArgs(argv)
  switch (command) {
    case 'projects': {
      const local = localProjects(cfg)
      for (const p of local) {
        const branch = run('git', ['-C', p.path, 'branch', '--show-current'])
        const dirty = run('git', ['-C', p.path, 'status', '--porcelain']) !== ''
        const last = run('git', ['-C', p.path, 'log', '-1', '--format=%cs %s'])
        out(`${p.name.padEnd(26)} ${branch.padEnd(16)} ${(dirty ? 'dirty' : '').padEnd(5)} ${last}`)
        out(`${''.padEnd(26)} ${p.remote || '(no remote)'}`)
      }
      if (options.remote) {
        const have = new Set(local.flatMap((p) => [norm(p.repo), norm(p.name)]))
        out(`\n--- on GitHub (${owner(cfg) || 'no owner'}), not cloned ---`)
        for (const r of githubRepos(cfg).filter((r) => !have.has(norm(r.name)))) {
          out(`${r.name.padEnd(26)} ${(r.isPrivate ? 'private' : 'public').padEnd(8)} ${r.description || ''}`)
        }
      }
      return
    }
    case 'resolve':
      out(resolveProject(cfg, options.project, Boolean(options.new)))
      return
    case 'start': {
      const prompt = options.promptFile ? fs.readFileSync(options.promptFile, 'utf8') : options.prompt
      let dir = options.dir
      if (!dir) {
        if (!options.project) throw new BridgeError('Give --project <name> (or --dir <path>)')
        dir = resolveProject(cfg, options.project, Boolean(options.new))
      }
      const maxTurns = options.maxTurns ? Number(options.maxTurns) : 0
      const job = startJob(cfg, { prompt, dir, resume: options.resume || null, model: options.model || null, maxTurns })
      out(`started job ${job.id} (pid ${job.pid}) in ${job.dir}`)
      return
    }
    case 'status': {
      const jobDir = jobDirOf(cfg, options.id)
      const s = jobState(jobDir)
      out(`job: ${s.id}\nstate: ${s.state}\ndir: ${s.dir}\nstarted: ${s.started}\nsession_id: ${s.session_id || ''}\nevents: ${s.events.length}`)
      if (s.result) {
        out(`turns: ${s.result.num_turns}  duration: ${Math.round((s.result.duration_ms || 0) / 1000)}s  cost: ${s.result.total_cost_usd} USD\n--- result ---\n${s.result.result ?? ''}`)
      } else {
        out('--- recent ---')
        for (const line of s.events.flatMap(formatEvent).slice(-8)) out(line)
      }
      const err = path.join(jobDir, 'err.txt')
      const errText = fs.existsSync(err) ? fs.readFileSync(err, 'utf8').split(/\r?\n/).filter((l) => l.trim()) : []
      if (errText.length) {
        out('--- stderr ---')
        for (const line of errText.slice(-15)) out(line)
      }
      return
    }
    case 'log': {
      const tail = options.tail ? Number(options.tail) : 30
      for (const line of readEvents(jobDirOf(cfg, options.id)).flatMap(formatEvent).slice(-tail)) out(line)
      return
    }
    case 'list': {
      if (!fs.existsSync(cfg.jobsDir)) return
      const ids = fs.readdirSync(cfg.jobsDir).filter((n) => JOB_ID.test(n)).sort().reverse()
      for (const id of ids) {
        try {
          const s = jobState(path.join(cfg.jobsDir, id))
          out(`${s.id}  ${s.state.padEnd(22)} ${path.basename(String(s.dir || '')).padEnd(22)} ${s.prompt || ''}`)
        } catch {
          out(`${id}  (no readable meta.json)`)
        }
      }
      return
    }
    case 'cancel': {
      const state = await cancelJob(cfg, options.id)
      out(state === 'cancelled' ? `cancelled ${options.id}` : `${options.id} had already ended (${state})`)
      return
    }
    default:
      throw new BridgeError(`Unknown command '${command}': projects, resolve, start, status, log, list or cancel`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof BridgeError ? e.message : e.stack || String(e))
    process.exit(1)
  })
}
