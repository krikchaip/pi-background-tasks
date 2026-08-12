# pi-background-tasks testing

The test suite covers the shell-task extension only.

## Commands

Default gate:

```nu
npm run test
```

This runs type checking plus type-safety, unit, SDK, RPC, component, and package tests.

Full gate:

```nu
npm run test:full
```

This adds real PTY/TUI and scripted-provider tests.

Release checks:

```nu
npm run smoke
npm run test:compat
npm run pack:dry-run
```

`test:compat` packs the plugin, installs it in isolated temporary projects, and starts supported Pi versions. It needs network access for package installation.

Run the Windows integration lane on Windows:

```nu
npm run test:windows
```

## Isolated environment

Tests must use temporary project, agent, and session directories. They must not read or write the user's Pi state.

The shared test environment sets:

```text
PI_OFFLINE=1
PI_SKIP_VERSION_CHECK=1
PI_TELEMETRY=0
CI=1
```

`PI_TELEMETRY=0` disables host Pi telemetry during tests. The extension does not collect child-agent telemetry.

## Coverage

The suite verifies:

- `bg_run`, `bg_status`, `bg_logs`, and `bg_kill` schemas and runtime behavior;
- `/bg`, `/jobs`, `/logs`, `/kill`, `/tasks`, `/bg-tasks`, and `/bg-clear`;
- shell spawn, output capture, bounded reads, timeout, output cap, process-tree kill, shutdown, and race handling;
- completion notifications, optional follow-up turns, and exactly-once terminal EventBus publication after durable metadata;
- focused dock list/detail views, history, output scrolling, stop, stop-all, rerun, path display, shortcuts, ANSI safety, and width limits;
- package contents, peer dependency posture, TypeBox compatibility, isolated tarball install, and extension startup;
- old session notifications can contain removed fields without exposing them in current snapshots.

Task metadata belongs to one extension runtime. A new Pi runtime uses a new directory and does not restore or reattach tasks from old runtime directories.

No default test uses an LLM, API key, network request, or the user's global Pi directory.

## PTY notes

`test:pty` uses `/usr/bin/expect` with a real Pi TUI. The harness answers Pi's terminal keyboard-protocol query before it sends input. If the host cannot pass raw-mode Node stdin through `expect`, the PTY tests skip with a clear reason. SDK, RPC, and component tests remain active.

## Smoke test

`scripts/smoke.ts` starts Pi with only `extensions/background-tasks.ts`, in offline print mode, and runs `/jobs`. It proves that the extension loads without a provider or user configuration.

Smoke does not replace `npm run test:full`.
