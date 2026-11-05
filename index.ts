import { readFile } from "node:fs/promises"
import { Plugin } from "@opencode/plugin"
import { buildPrompt, extractSummary } from "./compaction.js"
import { Compaction } from "./rpc.js"

export default Plugin.define({
  id: "custom-compaction-prompt",
  async setup(ctx) {
    // This file is the downloaded source. Do not rewrite it to OpenCode's template.
    const prompt = await readFile(new URL("./compact.md", import.meta.url), "utf8")
    const controller = new AbortController()
    const locks = new Map<string, Promise<unknown>>()

    async function exclusive<T>(sessionID: string, action: () => Promise<T>): Promise<T> {
      const previous = locks.get(sessionID) ?? Promise.resolve()
      const current = previous.catch(() => {}).then(action)
      locks.set(sessionID, current)
      try {
        return await current
      } finally {
        if (locks.get(sessionID) === current) locks.delete(sessionID)
      }
    }

    const key = (sessionID: string) => `pending/${sessionID}`

    await ctx.session.hook("compaction", async (event) => {
      const instructions = await exclusive(event.sessionID, async () => {
        const saved = await ctx.storage.get(key(event.sessionID))
        if (!saved || typeof saved !== "object" || !("id" in saved) || !("instructions" in saved)) return ""
        // Match the admitted control, not just the session. Automatic or background
        // work must not take instructions from a queued or cancelled manual request.
        const context = await ctx.session.context({ sessionID: event.sessionID })
        if (!context.some((message) => message.type === "compaction" && message.status === "running" && message.id === saved.id)) return ""
        await ctx.storage.remove(key(event.sessionID))
        return typeof saved.instructions === "string" ? saved.instructions : ""
      })
      const input = buildPrompt(prompt, event, instructions)

      // Stateless generation has no agent system prompt, tools, or chat turn.
      // Do not reject on a bytes-to-tokens estimate. Only the provider can enforce
      // its actual input limit; the configured compaction buffer is the early trigger.
      // A rejection must propagate: never return without a replacement result.
      const result = await ctx.experimental.generate.text({ model: event.model, prompt: input }, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]),
      })
      event.result = { summary: extractSummary(result.text) }
    })

    await ctx.rpc.register(Compaction, {
      compact: async (input) => {
        // The RPC validates the JSON shape before this handler runs.
        const { sessionID, instructions = "" } = input as {
          sessionID: Parameters<typeof ctx.session.compact>[0]["sessionID"]
          instructions?: string
        }
        await exclusive(sessionID, async () => {
          const previous = await ctx.storage.get(key(sessionID))
          try {
            const admitted = await ctx.session.compact({ sessionID })
            await ctx.storage.set(key(sessionID), { id: admitted.id, instructions: instructions.trim() })
          } catch (error) {
            if (previous === undefined) await ctx.storage.remove(key(sessionID))
            else await ctx.storage.set(key(sessionID), previous)
            throw error
          }
        })
        return null
      },
    })

    return () => controller.abort()
  },
})
