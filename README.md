# pi-herdr-subagents

**Pi subagents that run as real, visible Pi sessions in [Herdr](https://herdr.dev) panes.**

[![npm](https://img.shields.io/npm/v/@aaaxn/pi-herdr-subagents)](https://www.npmjs.com/package/@aaaxn/pi-herdr-subagents)
[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Every subagent is a normal Pi TUI in its own pane. You can watch it work, read its whole conversation, scroll its history, type into it, and keep it open after the delegated task finishes. The parent session still orchestrates the work through tools, so the model delegates exactly as it would with a headless extension.

```text
┌───────────────────────────┬───────────────────────────┐
│ parent Pi session         │ agent: review-auth        │
│                           │                           │
│ > spawn_agent(...)        │ > Review the auth module  │
│   started review-auth     │   reading src/auth.ts     │
│ > wait_agent(...)         │   ...                     │
│                           │                           │
│ agents  1 running         │ claude-opus-5 > high      │
└───────────────────────────┴───────────────────────────┘
```

## Requirements

- Pi 0.84.2 or newer
- Herdr 0.8.0 or newer
- Pi started inside a Herdr pane, so `HERDR_ENV=1` is set

This package calls the Herdr CLI directly. `@ogulcancelik/pi-herdr` is optional and only makes blocked-agent detection instant instead of taking up to 5 seconds.

## Install

```bash
pi install npm:@aaaxn/pi-herdr-subagents
```

Try it without installing permanently:

```bash
pi -e npm:@aaaxn/pi-herdr-subagents
```

## How a delegation runs

1. The parent model calls `spawn_agent` with a self-contained task message it wrote itself.
2. The extension opens a sibling pane, or an `agents · <session>` tab when a split would leave any pane smaller than 72x20.
3. Herdr starts a normal Pi session there with the chosen provider, model, and thinking level.
4. A private mailbox hands the task to the child, which delivers it through `pi.sendUserMessage()`.
5. When the child finishes, its reporter writes the final response to disk and the parent receives it as a structured result.
6. The pane stays open until you or the model closes it.

Nothing is scraped from the terminal, and no hidden prompt is injected into the child. The child keeps your `AGENTS.md`, skills, extensions, and working directory, and starts with an empty conversation.

## Tools

| Tool | Purpose |
| --- | --- |
| `spawn_agent` | Start an agent in a new pane with a task message |
| `send_message` | Send another turn to a running agent |
| `wait_agent` | Wait for the next agent to finish |
| `wait_all_agents` | Wait for several agents to finish |
| `list_agents` | List agents, their status, and their panes |
| `read_agent_response` | Page through a response larger than the delivered slice |
| `interrupt_agent` | Stop the current turn and keep the session usable |
| `focus_agent` | Move the Herdr focus to an agent pane |
| `close_agent` | Close an idle or finished agent pane |

Only the root session receives these tools. Child sessions load the reporter and `/return-to-parent`, so agents cannot spawn further agents.

Results are delivered automatically up to 64 KiB, with a `result_id` in every payload. Longer responses stay complete on disk, and `read_agent_response` returns the rest from any byte offset without splitting a UTF-8 character.

## Commands

```text
/agents                         list agents and focus the selected pane
/subagents                      alias for /agents
/subagent <name>                focus one pane
/agents close-done              close every idle or finished pane
/agents close <name>            close one idle or finished pane
/agents close <name> --force    force a close, from the user only
/agents purge                   delete metadata for runs already closed
```

A widget above the editor shows running, blocked, and undelivered agents while any run is open.

## Taking over an agent

Type in an agent pane whenever you want. Manual turns are yours, and the parent never sees them. When you want to hand the conversation back, run this in the child:

```text
/return-to-parent [optional note]
```

That forwards the last final response, plus your note, to the parent. Typing during a turn the parent requested steers that turn without breaking the link, so the parent still receives the result.

## Model profiles

Profiles choose only `provider`, `model`, and `thinking`. They never add a persona, system prompt, skill list, or tool list, so a subagent behaves like the Pi you already configured.

Configure them globally in `~/.pi/agent/pi-herdr-subagents.json`, or per project in `<project>/.pi/pi-herdr-subagents.json`, which is read only after you trust the project.

```json
{
  "defaultProfile": "general",
  "profiles": {
    "general": { "provider": "openai-codex", "model": "gpt-5.6-sol", "thinking": "high" },
    "explore": { "provider": "openai-codex", "model": "gpt-5.6-luna", "thinking": "xhigh" },
    "review": { "provider": "anthropic", "model": "claude-opus-5", "thinking": "xhigh" }
  },
  "layout": { "minPaneWidth": 72, "minPaneHeight": 20 },
  "limits": { "maxConcurrentAgents": 4, "maxOpenPanes": 8 },
  "retention": { "deliveredDays": 7, "undeliveredDays": 30 }
}
```

Without a profile, the child inherits the provider, model, and thinking level the parent is using.

## Layout and limits

Splits happen only when both resulting panes stay at least 72x20. Otherwise the extension creates or reuses a dedicated agents tab. Pane creation never steals your focus.

Defaults allow 4 agents starting, working, or blocked at once and 8 open panes. There is no hidden queue: past the limit, `spawn_agent` fails and tells the model to wait or close a pane.

Agents share your working tree. Version 0.1.0 does not create worktrees, so parallel write tasks should touch separate files.

## Data and retention

Coordination state lives under `~/.pi/agent/pi-herdr-subagents/runs/<parent-scope>/<run-id>/`, readable only by you. The mailbox uses versioned JSON, atomic writes, capability tokens, and acknowledgements, and each run belongs to one exact parent session.

- Inbox files are deleted only after Pi confirms the delegated input arrived.
- Active runs and open panes are never cleaned up.
- Closed runs with delivered results are kept for 7 days, and closed runs with an undelivered result for 30 days.
- Each run keeps the retention values that applied when it started, and `0` disables deletion for that category.
- Pi transcripts are never deleted by this extension.
- Resuming a different session never adopts agents from another one.

Project configuration is read only from trusted projects. Trust and permission prompts are never answered for you: an agent waiting on one is reported as `blocked` so you can decide in its pane.

## Development

```bash
npm install
npm run check
```

The Herdr test opens a real pane and runs a child Pi against a live model, so it is skipped unless you ask for it from inside a Herdr pane:

```bash
PI_HERDR_SMOKE=1 npx vitest run test/smoke.herdr.test.ts
```

Set `PI_HERDR_SMOKE_PROVIDER` and `PI_HERDR_SMOKE_MODEL` to choose the child model.

## Credits

[Herdr](https://herdr.dev) is built by [Can Celik](https://github.com/ogulcancelik), and this extension exists because of it. Its [`@ogulcancelik/pi-herdr`](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-herdr) extension showed how Pi and Herdr fit together, and reading it shaped how this package talks to the Herdr CLI. Thank you.

## License

MIT
