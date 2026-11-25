// The harness around a script's code (docs/specs/08-automation-scripts.md §4–5).
//
// Deno runs this file with no permissions except the script's own folder. It imports the
// script (./script.ts, written next to this file by the worker), and gives it `anemo`:
// every call is a JSON line on stdout that the worker answers with a JSON line on stdin.
// The worker checks and performs each call; nothing here is trusted by it.
import main from "./script.ts";

const encoder = new TextEncoder();
const lines = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).getReader();
let buffered = "";

async function writeLine(message) {
  const bytes = encoder.encode(JSON.stringify(message) + "\n");
  let written = 0;
  while (written < bytes.length) {
    written += await Deno.stdout.write(bytes.subarray(written));
  }
}

// Messages go out one at a time, in order (a log line never splits a request).
let outgoing = Promise.resolve();
function send(message) {
  outgoing = outgoing.catch(() => undefined).then(() => writeLine(message));
  return outgoing;
}

async function receive() {
  while (!buffered.includes("\n")) {
    const { value, done } = await lines.read();
    if (done) return null;
    buffered += value;
  }
  const end = buffered.indexOf("\n");
  const line = buffered.slice(0, end);
  buffered = buffered.slice(end + 1);
  return JSON.parse(line);
}

// One request at a time: a call that is not awaited waits for the one before it.
let pending = Promise.resolve();
function request(message) {
  const answer = pending.then(async () => {
    await send(message);
    const reply = await receive();
    if (reply === null || reply.type === "stop") Deno.exit(0); // the worker stopped it
    return reply;
  });
  pending = answer.catch(() => undefined);
  return answer;
}

export class ToolError extends Error {
  constructor(tool, message, denied) {
    super(message);
    this.name = "ToolError";
    this.tool = tool;
    this.denied = denied; // the permissions or the user said no
  }
}

// A refused or failed plugin method (anemo.api): `code` is one of the contract's error
// codes (docs/specs/CONTRACTS-plugins.md §6.3), so a script can branch on it.
export class PluginError extends Error {
  constructor(method, code, message) {
    super(message);
    this.name = "PluginError";
    this.method = method;
    this.code = code;
  }
}

function text(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function call(tool, args = {}) {
  const reply = await request({ type: "call", tool: String(tool), args });
  if (reply.is_error) throw new ToolError(tool, reply.content, Boolean(reply.denied));
  return { content: reply.content, data: reply.data ?? null };
}

// A plugin's methods (tasks.list, documents.get, ...) with the same JSON answers its
// panels and pages get. Only a plugin's own scripts have them (the worker refuses others).
async function api(method, params = {}) {
  const reply = await request({ type: "method", method: String(method), params });
  if (reply.error) throw new PluginError(method, reply.error.code, reply.error.message);
  return reply.result ?? null;
}

const anemo = {
  call,
  api,
  async think(prompt, data = null, options = {}) {
    const json = Boolean(options.json);
    const reply = await request({ type: "think", prompt: String(prompt), data, json });
    if (reply.is_error) throw new ToolError("think", reply.content, Boolean(reply.denied));
    return json ? reply.data.value : reply.content;
  },
  log(...parts) {
    return send({ type: "log", text: parts.map(text).join(" ") });
  },
  secret(name) {
    return `{{secret:${name}}}`; // the worker puts the value in, in request headers only
  },
  fetch(url, options = {}) {
    const args = { url: String(url), method: options.method ?? "GET", headers: options.headers ?? {} };
    if (options.json !== undefined) args.json_body = options.json;
    else if (options.body !== undefined) args.text_body = String(options.body);
    return call("http_request", args);
  },
  notify(title, message = "") {
    return call("send_notification", { title, message });
  },
  state: { set: (note) => call("update_automation_state", { note }) },
  tasks: {
    create: (args) => call("create_task", args),
    update: (args) => call("update_task", args),
    list: (args = {}) => call("list_tasks", args),
  },
  events: {
    create: (args) => call("create_event", args),
    update: (args) => call("update_event", args),
    list: (args = {}) => call("list_events", args),
  },
};

for (const level of ["log", "info", "warn", "error", "debug"]) {
  console[level] = (...parts) => {
    anemo.log(...parts);
  };
}

const start = await receive();
try {
  const result = await main(start?.input ?? {}, anemo);
  await send({ type: "done", result: result === undefined ? null : result });
} catch (error) {
  await send({ type: "error", message: String(error?.stack ?? error) });
}
await outgoing;
Deno.exit(0);
