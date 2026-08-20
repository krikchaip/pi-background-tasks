# pi-background-tasks

Tracked background **shell tasks** for [Pi](https://pi.dev/).

The package starts named shell commands, stores their output in temporary files, provides bounded log reads, stops timed-out or selected tasks, and shows task state in the focused task dock. A terminal task event is steered into the next model-call boundary while the agent is active. It can start a new turn when Pi is idle.

## Install

```bash
pi install git:github.com/krikchaip/pi-background-tasks@personal
```

## Commands

- `/bg [--name "Task name"] <command>` — start a tracked background shell command.
- `/jobs` — list running and recent tasks.
- `/logs <id> [maxBytes]` — show bounded task output and its full output path.
- `/kill <id>` — stop a running task.
- `/tasks` or `/bg-tasks` — open the focused task manager.
- `/bg-clear` — clear completed-task footer notices.

## Tools

- `bg_run` — start a named long-running shell command.
- `bg_status` — inspect one task or all recent tasks.
- `bg_logs` — read bounded task output.
- `bg_kill` — stop a running task.

`bg_run` requires `name` and `command`. It defaults `notifyOnCompletion` and `triggerOnCompletion` to `true`. A task terminal event then notifies the current Pi session through steering. It reaches the next model-call boundary while the agent is active, or starts a new turn when Pi is idle. Use `notifyOnCompletion: false` only when you will inspect the task yourself.

## Task dock

The main footer shows running and unacknowledged terminal task counts. Press `Shift+Down` to open the focused dock. In the dock, use arrows to select a task, `Enter` to view its output, `k` to stop a task, `R` to rerun it, and `x` to close the dock.

## Runtime files

Task output and metadata are written under the system temporary directory:

```text
<system-temp>/pi-bg-tasks/<session-id>-<pid>-<run-id>/<task-id>.output
<system-temp>/pi-bg-tasks/<session-id>-<pid>-<run-id>/<task-id>.json
```

Each Pi extension runtime uses a new directory. The plugin does not restore or reattach tasks from an old runtime directory.

The plugin starts shell commands only. It does not start, wrap, observe, or attest background agents.

## Development

```bash
npm run typecheck
npm run test:unit
npm run test:component
```
