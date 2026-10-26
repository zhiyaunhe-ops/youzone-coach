---
name: youzone-coach
description: >-
  Ask the YonZone implementation and delivery coaches about YonBIP product or development questions, and retrieve recorded answers. Use for requests to consult either coach, compare both coaches, follow up, or read chat history; their answers are knowledge leads and cannot establish facts about the user's environment.
---

# YonZone implementation and delivery coaches

The coaches are product and development knowledge bots. They cannot inspect the user's tenant, project, database, logs, configuration, or screenshots. Ask one focused question with the relevant business terminology; keep environment-specific investigation separate. Verify their suggested nodes, fields, formulas, and behavior in the actual environment before acting.

## Normal workflow

1. Use Node.js 22.5 or later and the running, logged-in YonZone desktop client with the required CDP support. Resolve coach aliases dynamically from the visible client directory: `impl` is the implementation coach and `delivery` is the delivery coach. Do not hardcode historical peer IDs.
2. From this installed skill directory, start the service through its background launcher and submit the same question to both coaches:

   ```bash
   node scripts/bg.js coach_ask_server.js
   node scripts/bg.js ask_both.js --file question.txt --timeout 420000 --out <project-directory> --tag <step>
   ```

   Use a UTF-8 question file when shell argument encoding is uncertain. Read `scripts/bg.js --tail ask_both` for progress.
3. Ask serially: send to the first coach and wait until its final answer has landed before switching to the second. Both use one shared `single-agent` webview. Do not switch conversations or tabs during an active answer.
4. Allow at least 420 seconds per coach. The service uses asynchronous task IDs and a FIFO queue; the per-question timeout starts when the task leaves the queue. Queue wait is separate from generation time. Track queued, running, and final state rather than submitting duplicates.
5. A timeout is not proof of a failed send. Retrieve the existing task result and inspect `/history?n=3&peer=impl|delivery` or `node scripts/dump_chat.js --peer impl|delivery` before re-asking or reporting a question as unsent. Keep waiting for an already submitted question when its answer is still pending.
6. Save both answers with the task step. Preserve each coach's ask and answer times in HKT, the saved record path, disagreements, and any unresolved or late result. Report the separate environment-verification evidence before implementing a suggestion.

## Operational boundaries

Use the desktop-backed channel for normal questions. The headless channel is disabled by default because it signs the desktop client out; use it only with explicit authorization for that effect and its existing `--kick-ok` opt-in. Do not replace an ordinary question with protocol experiments.

For chat-history requests, use the history/export route without sending a new question. If prerequisites are missing, follow the setup reference and report the exact missing prerequisite.

## Related documents

Read only the resource required by the current step.

| Need | Resource |
|---|---|
| First-machine setup, name discovery, history export, CDP, or missing/late answer diagnosis | [Desktop and history](references/desktop-and-history.md) |
| Direct API integration, task retrieval, queue semantics, or status fields | [Ask API](references/ask-api.md) |
| Explicit headless-channel or protocol implementation work | [Headless protocol](references/headless-protocol.md) |
| Modify, validate, or package this skill | [Maintenance and packaging](references/maintenance-and-packaging.md) |

[Project overview](README.md) contains installation and human-facing usage.
