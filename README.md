# Claude Compaction for OpenCode

An OpenCode 2.2.5 plugin that summarizes session history with the Claude Code compaction prompt in [`compact.md`](compact.md). It works for manual and automatic compaction and stores the result as the session checkpoint.

## Install

Add the plugin directory to your OpenCode configuration. Keep your existing settings and plugin entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-compaction-plugin"],
  "compaction": {
    "auto": true,
    "buffer": "20%"
  },
  "experimental": {
    "background_compaction": false
  }
}
```

Reload OpenCode after changing configuration or plugin files. Automatic compaction begins around the configured buffer threshold; `"20%"` leaves approximately 20% of usable context as headroom.

Keep background compaction disabled. A background-generated summary may be reused without running the plugin hook, so instructions passed to a later manual compaction may not apply.

## Use

Run `/compact` to summarize the current history. Add optional instructions after the command:

```text
/compact Preserve the test failures and explain the deployment constraints.
```

The command is available in slash completion and the command palette. Its instructions are scoped to that admitted compaction; automatic compaction uses the base prompt without extra instructions. Instructions guide the model but do not guarantee a particular style or wording.

## How it works

1. OpenCode invokes the plugin's `compaction` hook with the session history and selected compaction model.
2. The plugin renders roles, text, tool calls/results, prior text summaries, and instruction-file constraints as input data. It describes attachments without embedding their binary data and excludes provider-private reasoning.
3. The plugin sends that transcript, `compact.md`, and any one-time `/compact` instructions to stateless text generation. The call has no normal agent prompt or tools.
4. The plugin stores the completed `<summary>` block as the checkpoint. The `<analysis>` block is not stored.
5. OpenCode retains recent context and continues the session using that checkpoint.

The model is the one selected for compaction, including an `agents.compaction.model` override when configured. It can be any supported text model; the prompt is Claude Code's.

## Limits

- If generation fails, or the model does not return a complete `<summary>` block, compaction fails and the existing checkpoint is left unchanged. There is no fallback summary.
- The complete rendered transcript is sent without a local byte-based token estimate or silent transcript truncation. The provider enforces its context limit; provider errors are returned as failures.
- OpenCode's built-in transcript-shrinking recovery is not used by this plugin. A provider context-limit error requires a smaller history, earlier compaction, or a model with more input capacity.
- Opaque provider checkpoints cannot be converted to text by this plugin.
- Stateless generation does not report usage for the session's compaction cost display or stream summary text into the TUI.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run test:integration
```

The integration test runs a private OpenCode server with a local fake provider. On Linux, `TEST_TUI=1 npm run test:integration` also tests the real palette and slash-command flow; it requires `opencode` and util-linux `script` on `PATH`. Set `OPENCODE_BIN` to select a different OpenCode executable.
