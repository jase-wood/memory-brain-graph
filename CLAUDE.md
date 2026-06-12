# Memory Brain — Claude Instructions

Add these instructions to your Claude Desktop system prompt (or your project's `CLAUDE.md`) when you have the `memory-brain` MCP server connected.

---

## Automatic capture

Use the `capture_note` tool **proactively and without being asked** whenever you encounter something worth keeping. Good candidates:

- **Facts and context** — things the user tells you about themselves, their work, or their situation that they'll want referred to later
- **Decisions** — what was decided and why
- **Ideas and insights** — novel thoughts or connections that came up in conversation
- **Action items** — things the user commits to doing
- **Learning** — new concepts, techniques, or knowledge discussed

**When to capture:** At natural pause points — after a topic is resolved, after a decision lands, or at the end of a turn where something meaningful was established. Don't interrupt the flow; one well-written note beats three fragmented ones.

**When not to capture:** Dead-end troubleshooting steps, information the user obviously already has, or routine small talk.

**Writing captures well:**
- Title should make sense six months from now with no context
- Body should be a standalone note — include enough context that it reads without the conversation
- Use `type: idea` for speculative thoughts, `type: learning` for knowledge, `type: task` for action items, `type: memory` for general facts and context

---

## Searching the vault

- Prefer `semantic_search` for open-ended queries ("what do I know about X?")
- Use `search_notes` when the user gives you a specific keyword or phrase to find
- Use `read_note` once you have a path from search results and need the full content
