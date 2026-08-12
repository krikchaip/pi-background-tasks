# pi-background-tasks test plan

## Package surface

| Surface | Values |
|---|---|
| Entry point | `extensions/background-tasks.ts` |
| Commands | `/bg`, `/jobs`, `/logs`, `/kill`, `/tasks`, `/bg-tasks`, `/bg-clear` |
| Tools | `bg_run`, `bg_status`, `bg_logs`, `bg_kill` |
| EventBus | request, response, and terminal channels from `src/core/extension-api.ts` |
| Shortcuts | `Shift+Down`, `Ctrl+Alt+C` fallback |
| Runtime files | `<system-temp>/pi-bg-tasks/<run>/<task-id>.output` and `.json` |

## Required gates

| Gate | Command | Default | Purpose |
|---|---|---:|---|
| Type and API safety | `npm run typecheck`, `npm run test:type-safety` | yes | Compile source and tests; verify public schema types. |
| Core behavior | `npm run test:unit` | yes | State, files, spawn, kill, timeout, output cap, races, and EventBus protocol. |
| Real extension SDK | `npm run test:sdk` | yes | Load the extension and execute real shell tasks through tools and events. |
| RPC | `npm run test:rpc` | yes | Command discovery and headless command behavior. |
| Dock component | `npm run test:component` | yes | Rendering, keys, scrolling, actions, ANSI safety, and width limits. |
| Package | `npm run test:package` | yes | Manifest, packed files, TypeBox posture, and isolated install. |
| PTY/TUI | `npm run test:pty` | full | Real interactive Pi startup and dock input. |
| Completion loop | `npm run test:agent-loop` | full | Event-driven completion without status/log polling. |
| Startup smoke | `npm run smoke` | release | Offline extension load with `/jobs`. |
| Pi compatibility | `npm run test:compat` | release | Packed extension startup across supported Pi and TypeBox versions. |
| Pack inspection | `npm run pack:dry-run` | release | Published file set. |
| Windows | `npm run test:windows` | platform | Windows shell and process-tree behavior. |

## Feature matrix

| Feature | Lowest reliable layer | Required cases |
|---|---|---|
| Start task | unit + SDK + RPC | Named and derived names, empty command rejection, cwd, shell config, spawn failure, multiple tasks. |
| Inspect and logs | unit + SDK + RPC | Exact/prefix IDs, unknown/ambiguous IDs, head/tail bounds, missing file, full output path. |
| Stop and limits | unit + SDK + RPC | User kill, already-terminal rejection, timeout, output cap, process group/tree fallback, escalation. |
| Completion delivery | unit + SDK + scripted provider | All notification/wake combinations, terminal durability, exactly-once delivery, no polling contract. |
| EventBus service | unit + SDK | Closed frames, capabilities, duplicate IDs, lifecycle refusal, response barrier, terminal correlation. |
| Task dock | component + PTY | Empty/running/history states, detail tail, scrolling, stop, stop-all, rerun, path, close, shortcuts. |
| Persistence | unit + SDK | Durable output and metadata, terminal state, write failures, and pruning. |
| Shutdown | unit + SDK | All live tasks stop, waiters resolve, errors remain visible. |
| Packaging/startup | package + smoke + PTY | Only shell-task runtime ships; no removed feature names or files; Pi starts cleanly. |

## Compatibility rules

1. Task metadata is runtime-local. A new runtime does not load or reattach tasks from old runtime directories.
2. Old session notification details and v1 EventBus run requests can contain the legacy `isAgent` field. The extension validates and ignores it.
3. Public snapshots do not expose removed fields.
4. The extension does not import, register, document, or package Fusion, update-check, attestation, or child-agent telemetry code.
5. Tests do not use the user's Pi state or real model providers.

## Acceptance

- `npm run test:full` passes.
- `npm run smoke` starts Pi without an extension error.
- `npm run pack:dry-run` contains no removed runtime module.
- A real shell task can start, write output, report terminal state, return bounded logs, and be killed.
- Legacy session notifications render without an exception, and v1 EventBus requests ignore `isAgent` without exposing it in snapshots.
