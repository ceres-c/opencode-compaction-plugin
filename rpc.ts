import { Rpc } from "@opencode/plugin/rpc"

export const Compaction = Rpc.define({
  id: "custom-compaction-prompt",
  events: {},
  methods: {
    compact: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          instructions: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: { type: "null" },
    },
  },
})
