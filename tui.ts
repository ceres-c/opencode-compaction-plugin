import { Plugin } from "@opencode/plugin/tui"
import { Compaction } from "./rpc.js"

export default Plugin.define({
  id: "custom-compaction-prompt.tui",
  setup(ctx) {
    ctx.keymap.layer(() => ({
      mode: "global",
      priority: 100,
      commands: [{
        // Replace the built-in command, including its configured keyboard binding.
        id: "session.compact",
        title: "Compact with Claude's prompt",
        description: "Use /compact [instructions] to add instructions for this summary.",
        group: "Session",
        palette: true,
        slash: { name: "compact", arguments: true },
        enabled: () => ctx.ui.router.current().type === "session",
        run: async (instructions) => {
          const route = ctx.ui.router.current()
          if (route.type !== "session") return
          try {
            const session = ctx.data.session.get(route.sessionID) ?? await ctx.client.session.get({ sessionID: route.sessionID })
            await ctx.client.rpc(Compaction).compact(
              { sessionID: route.sessionID, instructions: instructions ?? "" },
              { location: session.location },
            )
            ctx.ui.toast.show({ message: "Claude compaction requested", variant: "info" })
          } catch {
            ctx.ui.toast.show({ message: "Could not request Claude compaction. Check the server log.", variant: "error" })
          }
        },
      }],
      bindings: ["session.compact"],
    }))
  },
})
