import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import { stripVTControlCharacters } from "node:util"
import { OpenCode } from "@opencode/client"
import { Rpc } from "@opencode/plugin/rpc"

test("OpenCode saves Claude checkpoints for manual and automatic compaction, then continues", { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp("/tmp/opencode/claude-compaction-integration-")
  const cleanups = []
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
    await rm(directory, { recursive: true, force: true })
  })
  const requests = []
  let failSummary = false
  let summaryNumber = 0
  const base = await readFile(new URL("compact.md", import.meta.url), "utf8")
  const provider = createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    const serialized = JSON.stringify(body)
    const summary = serialized.includes("CRITICAL: Respond with TEXT ONLY")
    if (summary && failSummary) {
      response.writeHead(400, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "Fixture summary failure", type: "invalid_request_error" } }))
      return
    }
    const text = summary
      ? `<analysis>Fixture scratch work.</analysis>\n<summary>1. Primary Request and Intent:\nCHECKPOINT_MARKER_${++summaryNumber}: preserve the user's work.</summary>`
      : "Fixture answer."
    const input = !summary && serialized.includes("ARM_AUTO") ? 45_000 : 200
    const usage = { prompt_tokens: input, completion_tokens: 20, total_tokens: input + 20 }
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" })
      for (const chunk of [
        { choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
      ]) response.write(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", ...chunk })}\n\n`)
      response.end("data: [DONE]\n\n")
    } else {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion", created: 1, model: "fixture", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }))
    }
  })
  provider.listen(0, "127.0.0.1")
  await once(provider, "listening")
  cleanups.push(() => { provider.closeAllConnections(); provider.close() })
  const port = provider.address().port
  await mkdir(`${directory}/home`)
  await writeFile(`${directory}/opencode.json`, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "fixture/model",
    plugins: [fileURLToPath(new URL(".", import.meta.url))],
    snapshots: false,
    compaction: { auto: true, buffer: "20%", keep: { tokens: 0 } },
    experimental: { background_compaction: false },
    agents: { title: { disabled: true }, build: { system: "NORMAL_AGENT_PROMPT_DO_NOT_SEND_TO_SUMMARIZER" } },
    policies: [{ action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "fixture", effect: "allow" }],
    providers: {
      fixture: {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "fixture-not-a-secret" },
        models: { model: { limit: { context: 50_000, output: 4_000 }, capabilities: { tools: true, input: ["text"], output: ["text"] } } },
      },
    },
  }))
  // Use a clean home and no inherited credentials. Never touch the user's service.
  const child = spawn(process.env.OPENCODE_BIN ?? "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: `${directory}/home`,
    env: {
      PATH: process.env.PATH,
      HOME: `${directory}/home`,
      XDG_CONFIG_HOME: `${directory}/config`, XDG_DATA_HOME: `${directory}/data`,
      XDG_CACHE_HOME: `${directory}/cache`, XDG_STATE_HOME: `${directory}/state`,
      OPENCODE_PASSWORD: "fixture-not-a-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  cleanups.push(async () => {
    if (child.exitCode !== null) return
    const ended = once(child, "exit")
    child.kill("SIGTERM")
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000)
    await ended
    clearTimeout(timeout)
  })
  let output = ""
  child.stdout.on("data", (data) => { output += data })
  child.stderr.on("data", (data) => { output += data })
  let url
  for (let attempt = 0; attempt < 200; attempt++) {
    url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
    if (url) break
    if (child.exitCode !== null) throw new Error(`Isolated server exited: ${output}`)
    await delay(100)
  }
  assert.ok(url, `Isolated server did not start: ${output}`)
  const client = OpenCode.make({ baseUrl: url, headers: { Authorization: `Basic ${Buffer.from("opencode:fixture-not-a-secret").toString("base64")}` } })
  const location = { directory }
  await client.agent.list({ location })
  const plugins = await client.plugin.list({ location })
  assert.ok(plugins.data.some((plugin) => plugin.id === "custom-compaction-prompt"), `${JSON.stringify(plugins)}\n${output}`)
  const rpc = client.rpc(Rpc.define({ id: "custom-compaction-prompt", events: {}, methods: { compact: { input: { type: "object" }, output: { type: "null" } } } }))
  const session = await client.session.create({ location, title: "Compaction integration", model: { providerID: "fixture", id: "model" } })
  const sessionID = session.id
  const wait = () => client.experimental.session.wait({ sessionID }, { signal: AbortSignal.timeout(15_000) })
  const history = () => client.experimental.session.export({ sessionID })
  await client.session.prompt({ sessionID, text: "Keep INITIAL_MARKER" })
  await wait()
  if (process.env.TEST_TUI) {
    const binary = process.env.OPENCODE_BIN ?? "opencode"
    assert.match(binary, /^[\w/.-]+$/)
    const terminal = spawn("script", ["-qefc", `${binary} --server ${url} --session ${sessionID}`, "/dev/null"], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: `${directory}/home`, XDG_CONFIG_HOME: `${directory}/config`, XDG_DATA_HOME: `${directory}/data`, XDG_CACHE_HOME: `${directory}/cache`, XDG_STATE_HOME: `${directory}/state`, OPENCODE_PASSWORD: "fixture-not-a-secret", TERM: "xterm-256color", COLUMNS: "120", LINES: "40" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    cleanups.push(async () => {
      if (terminal.exitCode !== null) return
      const ended = once(terminal, "exit")
      terminal.stdin.write("\x03\x03")
      terminal.kill("SIGTERM")
      const timeout = setTimeout(() => terminal.kill("SIGKILL"), 3000)
      await ended
      clearTimeout(timeout)
      terminal.stdin.destroy()
      terminal.stdout.destroy()
      terminal.stderr.destroy()
    })
    let screen = ""
    terminal.stdout.on("data", (data) => {
      const text = data.toString()
      screen += text
      if (text.includes("\x1b[6n")) terminal.stdin.write("\x1b[1;1R")
      if (text.includes("\x1b[c")) terminal.stdin.write("\x1b[?1;2c")
      if (text.includes("\x1b]11;?")) terminal.stdin.write("\x1b]11;rgb:0000/0000/0000\x1b\\")
    })
    terminal.stderr.on("data", (data) => { screen += data })
    const until = async (predicate) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return
        await delay(100)
      }
      assert.fail(`TUI check timed out: ${stripVTControlCharacters(screen).slice(-12000)}`)
    }
    await until(() => stripVTControlCharacters(screen).includes("Fixture answer"))
    screen = ""
    terminal.stdin.write("\x10") // Ctrl+P: command palette.
    await until(() => stripVTControlCharacters(screen).includes("Commands"))
    terminal.stdin.write("compact")
    await until(() => stripVTControlCharacters(screen).includes("Compact with Claude's prompt"))
    terminal.stdin.write("\x1b")
    await delay(200)
    screen = ""
    terminal.stdin.write("/comp")
    await until(() => stripVTControlCharacters(screen).includes("Use /compact [instructions]"))
    for (const character of "act Focus on EXTRA_INSTRUCTION_MARKER") {
      terminal.stdin.write(character)
      await delay(15)
    }
    terminal.stdin.write("\r")
    await until(() => requests.some((request) => JSON.stringify(request).includes("EXTRA_INSTRUCTION_MARKER")))
    terminal.stdin.write("\x03\x03")
  } else {
    await rpc.compact({ sessionID, instructions: "Focus on EXTRA_INSTRUCTION_MARKER" }, { location })
  }
  await wait()
  let exported = await history()
  const completed = () => exported.messages.filter((message) => message.type === "compaction" && message.status === "completed")
  assert.equal(completed().length, 1, JSON.stringify(exported))
  assert.ok(completed()[0].summary.includes("CHECKPOINT_MARKER"))
  assert.equal(completed()[0].summary.includes("<analysis>"), false)
  let summaries = requests.filter((request) => JSON.stringify(request).includes("CRITICAL: Respond with TEXT ONLY"))
  assert.equal(summaries.length, 1)
  assert.ok(summaries[0].messages.some((message) => message.content.includes(base)))
  assert.ok(JSON.stringify(summaries[0]).includes("EXTRA_INSTRUCTION_MARKER"))
  assert.equal(JSON.stringify(summaries[0]).includes("NORMAL_AGENT_PROMPT_DO_NOT_SEND_TO_SUMMARIZER"), false)
  assert.equal(summaries[0].tools?.length ?? 0, 0)

  const before = requests.length
  await client.session.prompt({ sessionID, text: "Continue after manual compaction" })
  await wait()
  assert.ok(requests.slice(before).some((request) => JSON.stringify(request).includes("CHECKPOINT_MARKER")))
  await client.session.prompt({ sessionID, text: "ARM_AUTO" })
  await wait()
  await client.session.prompt({ sessionID, text: "Continue after automatic compaction" })
  await wait()
  exported = await history()
  assert.ok(completed().length >= 2, JSON.stringify(exported))
  const primaryRequests = requests.filter((request) => !JSON.stringify(request).includes("CRITICAL: Respond with TEXT ONLY"))
  assert.ok(JSON.stringify(primaryRequests.at(-1)).includes("CHECKPOINT_MARKER_2"), "Continuation must use the automatic checkpoint")
  summaries = requests.filter((request) => JSON.stringify(request).includes("CRITICAL: Respond with TEXT ONLY"))
  assert.ok(summaries.length >= 2)
  // The earlier instruction can occur inside the previous transcript. It must not
  // be added again as this request's trailing Compact Instructions section.
  assert.ok(summaries.slice(1).every((request) => !request.messages.some((message) => message.content.endsWith("## Compact Instructions\nFocus on EXTRA_INSTRUCTION_MARKER"))))
  assert.equal(requests.some((request) => JSON.stringify(request).includes("Return only the updated Markdown sections")), false)
  assert.equal(requests.some((request) => JSON.stringify(request).includes("You MUST summarize the conversation above into a structured summary")), false)
  assert.equal(requests.some((request) => JSON.stringify(request).includes("The previous response did not fill in the required summary template")), false)

  // A valid repeated-word transcript can exceed the old bytes/3 threshold.
  // Prove the complete request reaches the provider through the real hook.
  const large = await client.session.create({ location, title: "Byte-estimate regression", model: { providerID: "fixture", id: "model" } })
  const transcript = " hello".repeat(24_000)
  await client.session.prompt({ sessionID: large.id, text: transcript })
  await client.experimental.session.wait({ sessionID: large.id }, { signal: AbortSignal.timeout(15_000) })
  await rpc.compact({ sessionID: large.id }, { location })
  await client.experimental.session.wait({ sessionID: large.id }, { signal: AbortSignal.timeout(15_000) })
  const largeHistory = await client.experimental.session.export({ sessionID: large.id })
  assert.ok(largeHistory.messages.some((message) => message.type === "compaction" && message.status === "completed"))
  const largeRequest = requests.find((request) => request.messages.some((message) => message.content.includes(base) && message.content.includes(transcript)))
  assert.ok(largeRequest, "Large transcript must reach the provider intact")

  const count = completed().length
  const summaryRequestsBeforeFailure = requests.filter((request) => JSON.stringify(request).includes("CRITICAL: Respond with TEXT ONLY")).length
  failSummary = true
  await rpc.compact({ sessionID }, { location })
  await wait()
  exported = await history()
  assert.equal(completed().length, count, "Failed summary must not replace the checkpoint")
  assert.equal(requests.filter((request) => JSON.stringify(request).includes("CRITICAL: Respond with TEXT ONLY")).length, summaryRequestsBeforeFailure + 1)
  assert.equal(requests.some((request) => JSON.stringify(request).includes("Return only the updated Markdown sections")), false)
})
