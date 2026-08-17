# pi-herdr-subagents

Visible, session-scoped Pi subagents running in real [Herdr](https://herdr.dev) panes.

Unlike headless subagent extensions, every child is a normal Pi TUI session. You can watch it work, focus its pane, inspect its complete conversation, type directly into it, and leave it open after the delegated task finishes.

## Requirements

- Pi `>=0.84.2`
- Herdr `>=0.8.0`
- Pi running inside Herdr (`HERDR_ENV=1`)

`@ogulcancelik/pi-herdr` is optional. This package talks directly to the Herdr CLI and does not import or call that extension.

## Install locally

`pi-codex-subagents` registers the same core tool names. Remove it, then install this local package so child Pi sessions load the reporter:

```bash
pi remove npm:@ogulcancelik/pi-codex-subagents
pi install /home/grad/si/23/arturxavier/pi-herdr-subagents
```

Then restart or reload Pi. The old extension's saved run data remains in its existing storage directory.

## Normal flow

1. The parent model calls `spawn_agent` with a self-contained task message.
2. The extension creates a readable sibling pane or an `agents · <session>` tab.
3. Herdr starts a normal Pi TUI with the selected model.
4. A private mailbox passes the parent-written task to `pi.sendUserMessage()` in the child.
5. The child reporter persists the final response and the parent receives a structural result message.
6. The pane stays open until explicitly closed.

Messages typed directly in the child are not returned automatically. Run this in the child when you want to hand a manual conversation back:

```text
/return-to-parent [optional note]
```

## Model profiles

Profiles select only `provider`, `model`, and `thinking`. They never inject a persona, system prompt, skill, tool list, or extension list.

Global configuration:

```text
~/.pi/agent/pi-herdr-subagents.json
```

Optional trusted-project override:

```text
<project>/.pi/pi-herdr-subagents.json
```

Example:

```json
{
  "defaultProfile": "general",
  "profiles": {
    "general": {
      "provider": "openai-codex",
      "model": "gpt-5.6-sol",
      "thinking": "high"
    },
    "explore": {
      "provider": "openai-codex",
      "model": "gpt-5.6-luna",
      "thinking": "xhigh"
    },
    "review": {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "thinking": "xhigh"
    }
  },
  "layout": {
    "minPaneWidth": 72,
    "minPaneHeight": 20
  },
  "limits": {
    "maxConcurrentAgents": 4,
    "maxOpenPanes": 8
  },
  "retention": {
    "deliveredDays": 7,
    "undeliveredDays": 30
  }
}
```

If no profile is selected or configured, the child inherits the active parent provider, model, and thinking level.

## Model-facing tools

- `spawn_agent`
- `send_message`
- `wait_agent`
- `wait_all_agents`
- `list_agents`
- `read_agent_response`
- `interrupt_agent`
- `focus_agent`
- `close_agent`

Only the root session gets orchestration tools. Child sessions load only their mailbox reporter and `/return-to-parent`, preventing recursive agent trees.

## Commands

```text
/agents                         list agents and focus the selected pane
/subagents                      alias for /agents
/subagent <name>                focus one pane
/agents close-done              close all idle/completed panes
/agents close <name>            close an idle/completed pane
/agents close <name> --force    explicit user-only forced close
/agents purge                   delete metadata for already closed runs
```

The model-facing `close_agent` cannot force-close working or blocked agents.

## Layout and limits

A split is used only when every resulting pane remains at least `72x20` by default. Otherwise the extension creates or extends a dedicated agents tab. Pane creation preserves the current focus.

Defaults:

- 4 starting, working, or blocked agents at once
- 8 open agent panes
- no hidden spawn queue
- no automatic pane closing

All agents share the project filesystem. Version `0.1.0` does not create worktrees, so parallel write tasks must target non-overlapping files.

## Persistence and cleanup

Coordination state is private to the current user:

```text
~/.pi/agent/pi-herdr-subagents/runs/<parent-scope>/<run-id>/
```

The mailbox uses versioned JSON, atomic writes, capability tokens, acknowledgments, and exact parent-session ownership.

- inbox files are deleted only after Pi confirms the delegated input;
- active runs and open panes are never cleaned;
- closed runs with delivered results are retained for 7 days;
- closed runs with any undelivered result are retained for 30 days;
- each run keeps the retention policy that was active when it was created;
- setting either retention value to `0` disables automatic deletion for that category;
- normal Pi child transcripts are never deleted by this extension;
- only resuming the exact same parent session reconnects prior runs.

Automatic result delivery includes at most 64 KiB. Each payload includes a `result_id`. The complete response remains on disk and in the child transcript; pass that `result_id` and the returned byte offset to `read_agent_response` for the remainder.

## Security

- Project-local configuration is read only after Pi marks the project trusted.
- Trust and permission prompts are never accepted automatically.
- Pane closing verifies exact run ownership and refuses the parent pane.
- New parent sessions do not adopt or receive another session's agents.

## Development

```bash
npm install
npm run check
```

The real Herdr test opens a visible pane and runs a child Pi against a live model. It is skipped unless you enable it from inside a Herdr pane:

```bash
PI_HERDR_SMOKE=1 npx vitest run test/smoke.herdr.test.ts
```

Override the child model with `PI_HERDR_SMOKE_PROVIDER` and `PI_HERDR_SMOKE_MODEL`.
