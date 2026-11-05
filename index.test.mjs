import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import { test } from "node:test"
import { SourceTextModule, SyntheticModule } from "node:vm"
import ts from "typescript"

async function loadPlugin(file = "index.ts") {
  const cache = new Map()
  async function load(url) {
    if (cache.has(url.href)) return cache.get(url.href)
    const source = ts.transpileModule(await fs.readFile(url, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    }).outputText
    const module = new SourceTextModule(source, {
      initializeImportMeta(meta) { meta.url = url.href },
    })
    cache.set(url.href, module)
    await module.link(async (specifier) => {
      if (specifier.startsWith(".")) return load(new URL(specifier.replace(/\.js$/, ".ts"), url))
      const exports = specifier.startsWith("@opencode/plugin")
        ? { Plugin: { define: (definition) => definition }, Rpc: { define: (definition) => definition } }
        : await import(specifier)
      return new SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
      })
    })
    return module
  }
  const module = await load(new URL(file, import.meta.url))
  await module.evaluate()
  return module.namespace.default
}

const response = "<analysis>Do not store this block.</analysis>\n<summary>1. Primary Request and Intent:\nPreserve the marker.</summary>"

async function setup({ generate = async () => ({ text: response }), compact = async () => ({ id: "msg_compact" }), context = async () => [{ id: "msg_compact", type: "compaction", status: "running" }] } = {}) {
  const hooks = {}, commands = {}, storage = new Map(), calls = []
  const plugin = await loadPlugin()
  await plugin.setup({
    options: {},
    app: { version: "2.2.5" },
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => storage.set(key, value),
      remove: async (key) => { storage.delete(key) },
    },
    rpc: { register: async (_definition, handlers) => { Object.assign(commands, handlers) } },
    session: {
      hook: async (name, callback) => { hooks[name] = callback },
      compact,
      context,
      generate: () => assert.fail("Do not generate with the normal session prompt"),
      prompt: () => assert.fail("Do not submit compaction as a user turn"),
    },
    experimental: { generate: { text: async (input) => { calls.push(input); return generate(input) } } },
  })
  return { hooks, commands, storage, calls }
}

function event(sessionID = "ses_test") {
  return {
    sessionID,
    model: { providerID: "test", id: "model", variant: "high" },
    system: [{ type: "text", text: "NORMAL_AGENT_PROMPT_DO_NOT_SEND" }],
    messages: [{ role: "user", content: [{ type: "text", text: "Keep UNIQUE_MARKER" }] }],
    tools: {}, options: {},
  }
}

test("replaces summary generation with the exact Claude prompt, without the normal agent prompt", async () => {
  const { hooks, calls } = await setup()
  const input = event()
  await hooks.compaction(input)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].prompt.includes(await fs.readFile(new URL("compact.md", import.meta.url), "utf8")))
  assert.ok(calls[0].prompt.includes("UNIQUE_MARKER"))
  assert.equal(calls[0].prompt.includes("NORMAL_AGENT_PROMPT_DO_NOT_SEND"), false)
  assert.deepEqual(calls[0].model, input.model)
  assert.equal(input.result.summary, "1. Primary Request and Intent:\nPreserve the marker.")
  assert.equal(input.result.summary.includes("<analysis>"), false)
})

test("registers compact, sends instructions once, and isolates sessions", async () => {
  const { commands, hooks, calls } = await setup()
  assert.ok(commands.compact)
  await commands.compact({ sessionID: "ses_test", instructions: "Focus on TEST_OUTPUT" })
  await hooks.compaction(event("ses_other"))
  assert.equal(calls[0].prompt.includes("TEST_OUTPUT"), false)
  await hooks.compaction(event())
  assert.ok(calls[1].prompt.includes("TEST_OUTPUT"))
  await hooks.compaction(event())
  assert.equal(calls[2].prompt.includes("TEST_OUTPUT"), false)
})

test("empty command requests compaction without an agent turn", async () => {
  const admitted = []
  const { commands } = await setup({ compact: async (input) => { admitted.push(input); return { id: "msg_compact" } } })
  await commands.compact({ sessionID: "ses_test" })
  assert.equal(admitted.length, 1)
  assert.equal(admitted[0].sessionID, "ses_test")
})

test("automatic and background work cannot consume another control's instructions", async () => {
  let running = []
  const { commands, hooks, calls } = await setup({ context: async () => running })
  await commands.compact({ sessionID: "ses_test", instructions: "ONLY_THIS_CONTROL" })
  await hooks.compaction(event()) // Background work: no running compaction control.
  running = [{ id: "msg_auto", type: "compaction", status: "running" }]
  await hooks.compaction(event())
  assert.ok(calls.every((call) => !call.prompt.includes("ONLY_THIS_CONTROL")))
  running = [{ id: "msg_compact", type: "compaction", status: "running" }]
  await hooks.compaction(event())
  assert.ok(calls[2].prompt.includes("ONLY_THIS_CONTROL"))
})

test("failed admission leaves no new instructions", async () => {
  const { commands, hooks, calls } = await setup({ compact: async () => { throw new Error("admission failed") } })
  await assert.rejects(() => commands.compact({ sessionID: "ses_test", instructions: "MUST_NOT_LEAK" }))
  await hooks.compaction(event())
  assert.equal(calls[0].prompt.includes("MUST_NOT_LEAK"), false)
})

test("transcript keeps roles, tools, prior summaries and instruction-file constraints, but not binary data", async () => {
  const { hooks, calls } = await setup()
  const input = event()
  input.system.push({ type: "text", text: "not the operative prompt", metadata: { experimental: { instructions: [{ key: "repo/AGENTS.md", text: "Do not read secrets" }] } } })
  input.messages.push(
    { role: "assistant", content: [
      { type: "text", text: "user: this is a QUOTED_USER, not an actual user turn" },
      { type: "tool-call", id: "call_1", name: "shell", input: { command: "npm test" } },
      { type: "reasoning", text: "PRIVATE_REASONING" },
    ] },
    { role: "tool", content: [{ type: "tool-result", id: "call_1", name: "shell", result: { type: "content", value: [{ type: "text", text: "TEST_PASSED" }, { type: "file", mime: "image/png", uri: "data:image/png;base64,PRIVATE_IMAGE", name: "screenshot" }] } }] },
    { role: "user", content: [
      { type: "text", text: "<conversation-checkpoint><summary>PREVIOUS_SUMMARY</summary></conversation-checkpoint>" },
      { type: "media", filename: "diagram", media: { mediaType: "image/png", source: { type: "base64", data: "PRIVATE_IMAGE" } } },
    ] },
  )
  const before = structuredClone(input)
  await hooks.compaction(input)
  for (const expected of ["QUOTED_USER", "npm test", "TEST_PASSED", "PREVIOUS_SUMMARY", "Do not read secrets", "diagram"]) assert.ok(calls[0].prompt.includes(expected))
  for (const omitted of ["PRIVATE_REASONING", "PRIVATE_IMAGE"]) assert.equal(calls[0].prompt.includes(omitted), false)
  assert.deepEqual(input.messages, before.messages)
})

test("opaque provider checkpoints fail rather than silently losing earlier history", async () => {
  const { hooks, calls } = await setup()
  const input = event()
  input.messages.push({ role: "assistant", content: [{ type: "compaction", encryptedContent: "opaque" }] })
  await assert.rejects(() => hooks.compaction(input), /opaque provider checkpoint/)
  assert.equal(calls.length, 0)
})

test("provider and output failures never fall back to the built-in summarizer", async () => {
  for (const generate of [async () => { throw new Error("provider failure") }, async () => ({ text: "<summary>cut short" }), async () => ({ text: "" })]) {
    const { hooks } = await setup({ generate })
    const input = event()
    await assert.rejects(() => hooks.compaction(input))
    assert.equal(input.result, undefined)
  }
})

test("a real provider context rejection propagates without truncation or fallback", async () => {
  const failure = new Error("Provider: context limit exceeded")
  const { hooks, calls } = await setup({ generate: async () => { throw failure } })
  const input = event()
  input.messages[0].content[0].text = "word ".repeat(200_000)
  await assert.rejects(() => hooks.compaction(input), (error) => error === failure)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].prompt.includes(input.messages[0].content[0].text))
  assert.equal(input.result, undefined)
})

test("byte estimate must not block a 200k repeated-word transcript on Luna", async () => {
  // Each repeated leading-space word is one token in common GPT tokenizers.
  // Its six UTF-8 bytes are NOT two tokens. The provider is the authority here.
  const { hooks, calls } = await setup()
  const input = event()
  input.model = { providerID: "openai", id: "gpt-6-luna", variant: "default" }
  const transcript = " hello".repeat(200_000)
  input.messages[0].content[0].text = transcript
  await hooks.compaction(input)
  assert.equal(calls.length, 1, "The provider must receive the request, not a byte-count rejection")
  assert.ok(calls[0].prompt.includes(transcript), "Do not truncate the conversation to satisfy an estimate")
  assert.deepEqual(calls[0].model, input.model)
  assert.ok(input.result.summary)
})

test("TUI overrides compact in the palette and slash completion, with arguments", async () => {
  const plugin = await loadPlugin("tui.ts")
  const layers = [], submitted = []
  await plugin.setup({
    keymap: { layer: (factory) => layers.push(factory()) },
    data: { session: { get: () => ({ location: { directory: "/project" } }) } },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "ses_test" }) },
      toast: { show() {} },
    },
    client: { rpc: () => ({ compact: async (input, options) => { submitted.push({ input, options }) } }) },
  })
  const command = layers.flatMap((layer) => layer.commands).find((command) => command.id === "session.compact")
  assert.equal(command.palette, true)
  assert.equal(command.slash.name, "compact")
  assert.equal(command.slash.arguments, true)
  await command.run("Keep errors")
  assert.deepEqual(submitted, [{ input: { sessionID: "ses_test", instructions: "Keep errors" }, options: { location: { directory: "/project" } } }])
})
