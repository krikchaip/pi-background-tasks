import { existsSync } from "node:fs";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import {
	boundedRead,
	compactWhitespace,
	formatCompactNumber,
	formatDuration,
	taskDisplayName,
	truncateChars,
	type BgTaskSnapshot,
} from "../core/common.js";

export type BackgroundTaskForUi = BgTaskSnapshot & { name: string; outputAbsPath: string };
type BgTask = BackgroundTaskForUi;
type TaskManagerTui = Pick<TUI, "requestRender"> & { terminal?: Partial<Pick<TUI["terminal"], "columns" | "rows">> };

const STATUS_INTERVAL_MS = 1000;
// Detail-view scrollback reservoir. Larger than the model-facing log cap because
// this is a UI-only read; a local 128KiB tail read per second is negligible and
// gives thousands of lines of scrollback when the user pauses the live tail.
const DETAIL_TAIL_BYTES = 128 * 1024;
const LIST_VISIBLE_ROWS = 14;
const DETAIL_VISIBLE_OUTPUT_LINES = 12;
const OVERLAY_MAX_HEIGHT_PERCENT = 60;
const OVERLAY_VERTICAL_MARGIN_ROWS = 1;
const FRAME_LINES = 7;
const DETAIL_SEPARATOR_LINES = 2;
const OUTPUT_BOX_CHROME_LINES = 3;
const MIN_DETAIL_LINES = 1;
const MIN_OUTPUT_LINES = 1;
const BORDER_COLOR: ThemeColor | `#${string}` = "accent";
const ANSI_FG_RESET = "\x1b[39m";

function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString();
}

/** Normalize raw output bytes into display lines, dropping only the trailing empty line from a final newline. */
function toOutputLines(content: string): string[] {
	return content.replace(/\r/g, "").split("\n").filter((line, index, array) => line.length > 0 || index < array.length - 1);
}

function padAnsi(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function isHexColor(color: ThemeColor | `#${string}`): color is `#${string}` {
	return color.startsWith("#");
}

function hexFg(hex: `#${string}`, value: string): string {
	const color = hex.slice(1);
	const r = parseInt(color.slice(0, 2), 16);
	const g = parseInt(color.slice(2, 4), 16);
	const b = parseInt(color.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m${value}${ANSI_FG_RESET}`;
}

function colorText(theme: Theme, color: ThemeColor | `#${string}`, value: string): string {
	return isHexColor(color) ? hexFg(color, value) : theme.fg(color, value);
}

function statusLabel(status: BgTaskSnapshot["status"]): string {
	if (status === "completed") return "done";
	if (status === "failed") return "error";
	if (status === "killed") return "stopped";
	return "running";
}

function statusColor(theme: Theme, status: BgTaskSnapshot["status"], text = statusLabel(status)): string {
	if (status === "completed") return theme.fg("success", text);
	if (status === "failed") return theme.fg("error", text);
	if (status === "killed") return theme.fg("warning", text);
	return theme.fg("accent", text);
}

function taskAge(task: BgTask, now = Date.now()): string {
	return formatDuration((task.endTime ?? now) - task.startTime);
}

function formatContextUsage(task: BgTask): string {
	const usage = task.contextUsage;
	if (!usage || !usage.contextWindow) return "—";
	const window = formatCompactNumber(usage.contextWindow);
	if (usage.percent === null || usage.tokens === null) return `?/${window}`;
	return `${usage.percent.toFixed(1)}%/${window}`;
}

function formatContextDetail(task: BgTask): string {
	const usage = task.contextUsage;
	if (!usage || !usage.contextWindow) return "not reported by this background task";
	const window = formatCompactNumber(usage.contextWindow);
	if (usage.percent === null || usage.tokens === null) return `unknown tokens / ${window} window`;
	return `${usage.percent.toFixed(1)}% of ${window} window (${formatCompactNumber(usage.tokens)} tokens)`;
}

function formatTokenUsage(task: BgTask): string {
	const usage = task.tokenUsage;
	if (!usage || usage.totalTokens <= 0) return "";
	return `tok ${formatCompactNumber(usage.totalTokens)}`;
}

function formatTokenDetail(task: BgTask): string {
	const usage = task.tokenUsage;
	if (!usage || usage.totalTokens <= 0) return "not reported by this background task";
	const parts = [
		`input ${formatCompactNumber(usage.input)}`,
		`output ${formatCompactNumber(usage.output)}`,
		`cache read ${formatCompactNumber(usage.cacheRead)}`,
		`cache write ${formatCompactNumber(usage.cacheWrite)}`,
		`total ${formatCompactNumber(usage.totalTokens)}`,
	];
	return parts.join(" · ");
}

function formatToolUsage(task: BgTask): string {
	const usage = task.toolUsage;
	if (!usage || (usage.total <= 0 && usage.failed <= 0)) return "";
	return usage.failed > 0 ? `tools ${usage.total}/${usage.failed} failed` : `tools ${usage.total}`;
}

function formatToolDetail(task: BgTask): string {
	const usage = task.toolUsage;
	if (!usage || (usage.total <= 0 && usage.failed <= 0)) return "not reported by this background task";
	const byName = Object.entries(usage.byName ?? {})
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 6)
		.map(([name, count]) => `${name} ${count}`);
	const parts = [`${usage.total} total`];
	if (usage.failed > 0) parts.push(`${usage.failed} failed`);
	parts.push(...byName);
	return parts.join(" · ");
}

function shortModelName(model: string): string {
	const slash = model.lastIndexOf("/");
	return slash >= 0 ? model.slice(slash + 1) : model;
}

function formatModel(task: BgTask): string {
	if (!task.model) return "";
	return `model ${shortModelName(task.model)}`;
}

function formatModelDetail(task: BgTask): string {
	if (!task.model) return "not reported by this background task";
	return task.model;
}

function contextColor(theme: Theme, task: BgTask, text: string): string {
	const percent = task.contextUsage?.percent ?? 0;
	if (percent > 90) return theme.fg("error", text);
	if (percent > 70) return theme.fg("warning", text);
	return theme.fg("dim", text);
}

function sortTasksForUi(tasks: BgTask[]): BgTask[] {
	const rank = (task: BgTask) => (task.status === "running" ? 0 : task.status === "failed" ? 1 : task.status === "killed" ? 2 : 3);
	return [...tasks].sort((a, b) => {
		const rankDiff = rank(a) - rank(b);
		if (rankDiff !== 0) return rankDiff;
		return (b.endTime ?? b.startTime) - (a.endTime ?? a.startTime);
	});
}

export type TaskManagerResult = "closed";

export type StopAllResult = {
	stopped: number;
	failures: string[];
};

export type TaskManagerOptions = {
	initialTaskId?: string;
	getTasks: () => BgTask[];
	stopTask: (task: BgTask) => Promise<void>;
	stopAllRunning: () => Promise<StopAllResult>;
	rerunTask: (task: BgTask) => Promise<BgTask>;
	showOutputPath: (task: BgTask) => void;
	markSeen: (taskId: string) => void;
	markFinishedSeen: (taskIds: string[]) => void;
	isSeen: (taskId: string) => boolean;
};

export class BackgroundTasksManager implements Component {
	private mode: "list" | "detail" = "list";
	private selectedIndex = 0;
	private listScroll = 0;
	private detailTaskId: string | undefined;
	private showHistory = false;
	private detailLines: string[] = [];
	private detailFollow = true;
	private detailScrollTop = 0;
	private tailBytesRead = 0;
	private tailTotalBytes = 0;
	private tailTruncated = false;
	private tailError: string | undefined;
	private actionMessage: string | undefined;
	private confirmStopAllArmed = false;
	private readonly lastBytesByTask = new Map<string, number>();
	private readonly recentActivityByTask = new Map<string, { delta: number; timestamp: number }>();
	private refreshTimer: NodeJS.Timeout;

	constructor(
		private readonly tui: TaskManagerTui,
		private readonly theme: Theme,
		private readonly done: (result: TaskManagerResult) => void,
		private readonly options: TaskManagerOptions,
	) {
		if (options.initialTaskId) {
			this.detailTaskId = options.initialTaskId;
			this.mode = "detail";
			this.options.markSeen(options.initialTaskId);
			void this.refreshTail();
		} else {
			const allTasks = options.getTasks();
			const hasRunning = allTasks.some((task) => task.status === "running");
			const hasFinished = allTasks.some((task) => task.status !== "running");
			if (!hasRunning && hasFinished) this.showHistory = true;
		}
		this.refreshTimer = setInterval(() => {
			if (this.mode === "detail") void this.refreshTail();
			this.tui.requestRender();
		}, STATUS_INTERVAL_MS);
	}

	dispose(): void {
		clearInterval(this.refreshTimer);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const stopAllKey = data === "a" || data === "A" || data === "K";
		if (!stopAllKey) this.confirmStopAllArmed = false;
		this.actionMessage = undefined;

		if (matchesKey(data, "escape") || data === "q" || data === "Q" || data === "x" || data === "X") {
			this.close();
			return;
		}

		if (this.mode === "detail") {
			this.handleDetailInput(data);
			return;
		}
		this.handleListInput(data);
	}

	render(width: number): string[] {
		const boxWidth = Math.max(2, Math.min(width, 118));
		return this.mode === "detail" ? this.renderDetail(boxWidth) : this.renderList(boxWidth);
	}

	private maxOverlayLines(minLines: number): number {
		const rows = this.tui.terminal?.rows;
		if (!rows) return Number.POSITIVE_INFINITY;
		const available = Math.max(1, rows - OVERLAY_VERTICAL_MARGIN_ROWS);
		const maxHeight = Math.floor(rows * OVERLAY_MAX_HEIGHT_PERCENT / 100);
		if (maxHeight < minLines) return available;
		return Math.max(1, Math.min(maxHeight, available));
	}

	private close(): void {
		this.done("closed");
	}

	private handleListInput(data: string): void {
		const tasks = this.currentTasks();
		if (tasks.length === 0) {
			if (matchesKey(data, "return")) this.close();
			if (data === "h" || data === "H") {
				this.showHistory = !this.showHistory;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selectedIndex = Math.min(tasks.length - 1, this.selectedIndex + 1);
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - LIST_VISIBLE_ROWS);
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.selectedIndex = Math.min(tasks.length - 1, this.selectedIndex + LIST_VISIBLE_ROWS);
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "right")) {
			const task = tasks[this.selectedIndex];
			if (!task) return;
			this.openDetail(task.id);
			return;
		}
		if (data === "k") {
			const task = tasks[this.selectedIndex];
			if (task) void this.stopTaskFromUi(task);
			return;
		}
		if (data === "K" || data === "a" || data === "A") {
			void this.stopAllFromUi();
			return;
		}
		if (data === "R") {
			const task = tasks[this.selectedIndex];
			if (task) void this.rerunTaskFromUi(task);
			return;
		}
		if (data === "c" || data === "C") {
			const task = tasks[this.selectedIndex];
			if (task) this.showOutputPathFromUi(task);
			return;
		}
		if (data === "h" || data === "H") {
			this.showHistory = !this.showHistory;
			this.selectedIndex = 0;
			this.listScroll = 0;
			this.tui.requestRender();
		}
	}

	private handleDetailInput(data: string): void {
		const task = this.detailTask();
		if (matchesKey(data, "left")) {
			this.mode = "list";
			this.detailTaskId = undefined;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "up")) {
			this.scrollDetail(-1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.scrollDetail(1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollDetail(-DETAIL_VISIBLE_OUTPUT_LINES);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollDetail(DETAIL_VISIBLE_OUTPUT_LINES);
			return;
		}
		if (data === "r") {
			this.detailFollow = true;
			this.detailScrollTop = 0;
			void this.refreshTail();
			return;
		}
		if (data === "R" && task) {
			void this.rerunTaskFromUi(task);
			return;
		}
		if (data === "k" && task) {
			void this.stopTaskFromUi(task);
			return;
		}
		if ((data === "c" || data === "C") && task) {
			this.showOutputPathFromUi(task);
		}
	}

	private currentTasks(): BgTask[] {
		const allTasks = this.options.getTasks();
		let visible = this.showHistory ? allTasks : allTasks.filter((task) => task.status === "running");
		if (!this.showHistory && visible.length === 0 && allTasks.some((task) => task.status !== "running")) {
			this.showHistory = true;
			visible = allTasks;
		}
		return sortTasksForUi(visible);
	}

	private detailTask(): BgTask | undefined {
		return this.options.getTasks().find((task) => task.id === this.detailTaskId);
	}

	private openDetail(taskId: string): void {
		this.detailTaskId = taskId;
		this.mode = "detail";
		this.detailLines = [];
		this.detailFollow = true;
		this.detailScrollTop = 0;
		this.tailError = undefined;
		this.options.markSeen(taskId);
		void this.refreshTail();
		this.tui.requestRender();
	}

	private ensureSelectionVisible(): void {
		if (this.selectedIndex < this.listScroll) this.listScroll = this.selectedIndex;
		if (this.selectedIndex >= this.listScroll + LIST_VISIBLE_ROWS) this.listScroll = this.selectedIndex - LIST_VISIBLE_ROWS + 1;
	}

	private async stopTaskFromUi(task: BgTask): Promise<void> {
		if (task.status !== "running") {
			this.actionMessage = `${taskDisplayName(task)} is ${task.status}; nothing to stop.`;
			this.tui.requestRender();
			return;
		}
		this.actionMessage = `Stopping ${taskDisplayName(task)}…`;
		this.tui.requestRender();
		try {
			await this.options.stopTask(task);
			this.actionMessage = `Stopped ${taskDisplayName(task)}.`;
		} catch (error) {
			this.actionMessage = `Stop failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.tui.requestRender();
	}

	private async stopAllFromUi(): Promise<void> {
		const running = this.options.getTasks().filter((task) => task.status === "running");
		if (running.length === 0) {
			this.actionMessage = "No running background tasks to stop.";
			this.tui.requestRender();
			return;
		}
		if (!this.confirmStopAllArmed) {
			this.confirmStopAllArmed = true;
			this.actionMessage = `Press a/K again to stop all ${running.length} running task${running.length === 1 ? "" : "s"}.`;
			this.tui.requestRender();
			return;
		}

		this.confirmStopAllArmed = false;
		this.actionMessage = `Stopping ${running.length} running task${running.length === 1 ? "" : "s"}…`;
		this.tui.requestRender();
		try {
			const result = await this.options.stopAllRunning();
			this.actionMessage = result.failures.length > 0
				? `Stopped ${result.stopped}; ${result.failures.length} failed: ${result.failures.join("; ")}`
				: `Stopped ${result.stopped} running task${result.stopped === 1 ? "" : "s"}.`;
		} catch (error) {
			this.actionMessage = `Stop-all failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.tui.requestRender();
	}

	private async rerunTaskFromUi(task: BgTask): Promise<void> {
		this.actionMessage = `Rerunning ${taskDisplayName(task)}…`;
		this.tui.requestRender();
		try {
			const rerun = await this.options.rerunTask(task);
			this.showHistory = false;
			const tasks = this.currentTasks();
			const index = tasks.findIndex((candidate) => candidate.id === rerun.id);
			if (index >= 0) {
				this.selectedIndex = index;
				this.ensureSelectionVisible();
			}
			this.actionMessage = `Reran as ${taskDisplayName(rerun)} (${rerun.id}).`;
		} catch (error) {
			this.actionMessage = `Rerun failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.tui.requestRender();
	}

	private showOutputPathFromUi(task: BgTask): void {
		this.options.showOutputPath(task);
		this.actionMessage = `Output path shown for ${taskDisplayName(task)}.`;
		this.tui.requestRender();
	}

	/** Scroll the detail output window. Scrolling up pauses the live tail; reaching the bottom resumes it. */
	private scrollDetail(delta: number): void {
		const maxTop = Math.max(0, this.detailLines.length - DETAIL_VISIBLE_OUTPUT_LINES);
		if (maxTop === 0) return;
		if (this.detailFollow) {
			this.detailFollow = false;
			this.detailScrollTop = maxTop;
		}
		this.detailScrollTop = Math.min(maxTop, Math.max(0, this.detailScrollTop + delta));
		if (this.detailScrollTop >= maxTop) {
			this.detailFollow = true;
			this.detailScrollTop = 0;
			void this.refreshTail();
		}
		this.tui.requestRender();
	}

	private async refreshTail(): Promise<void> {
		const task = this.detailTask();
		if (!task) return;
		// While the user has scrolled up, the buffer is frozen so their view stays stable.
		if (!this.detailFollow) return;
		try {
			if (!existsSync(task.outputAbsPath)) {
				this.detailLines = [];
				this.tailBytesRead = 0;
				this.tailTotalBytes = 0;
				this.tailTruncated = false;
				this.tailError = `Output file not found: ${task.outputPath}`;
				this.tui.requestRender();
				return;
			}
			const read = await boundedRead(task.outputAbsPath, DETAIL_TAIL_BYTES, true);
			this.detailLines = toOutputLines(read.content);
			this.tailBytesRead = read.bytesRead;
			this.tailTotalBytes = read.totalBytes;
			this.tailTruncated = read.truncated;
			this.tailError = undefined;
		} catch (error) {
			this.tailError = `Output read failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.tui.requestRender();
	}

	private activityLabel(task: BgTask): string {
		if (task.status !== "running") return "";
		const now = Date.now();
		const previous = this.lastBytesByTask.get(task.id);
		this.lastBytesByTask.set(task.id, task.bytesWritten);
		if (previous !== undefined && task.bytesWritten > previous) {
			const delta = task.bytesWritten - previous;
			this.recentActivityByTask.set(task.id, { delta, timestamp: now });
			return `+${formatSize(delta)} ↑`;
		}
		const recent = this.recentActivityByTask.get(task.id);
		if (recent && now - recent.timestamp < 3000) return `+${formatSize(recent.delta)} ↑`;
		return "";
	}

	private frame(title: string, subtitle: string, body: string[], footer: string, width: number): string[] {
		const inner = Math.max(1, width - 2);
		const border = (value: string) => colorText(this.theme, BORDER_COLOR, value);
		const top = border(`╭${"─".repeat(inner)}╮`);
		const bottom = border(`╰${"─".repeat(inner)}╯`);
		const row = (content = "") => `${border("│")}${padAnsi(truncateToWidth(content, inner), inner)}${border("│")}`;
		const header = this.theme.fg("accent", this.theme.bold(padAnsi(` ${title}`, inner)));
		const subtitleLine = subtitle ? this.theme.fg("muted", padAnsi(` ${subtitle}`, inner)) : " ".repeat(inner);
		const lines = [top, row(header), row(subtitleLine), row()];
		for (const line of body) lines.push(row(line));
		lines.push(row());
		lines.push(row(footer));
		lines.push(bottom);
		return lines;
	}

	private renderList(width: number): string[] {
		const tasks = this.currentTasks();
		if (this.selectedIndex >= tasks.length) this.selectedIndex = Math.max(0, tasks.length - 1);
		this.ensureSelectionVisible();

		const allTasks = this.options.getTasks();
		const allRunning = allTasks.filter((task) => task.status === "running").length;
		const historyCount = allTasks.length - allRunning;
		const unseenFailed = allTasks.filter((task) => task.status === "failed" && !this.options.isSeen(task.id)).length;
		const unseenStopped = allTasks.filter((task) => task.status === "killed" && !this.options.isSeen(task.id)).length;
		const unseenDone = allTasks.filter((task) => task.status === "completed" && !this.options.isSeen(task.id)).length;
		const unread = unseenFailed + unseenStopped + unseenDone;
		const subtitleParts = this.showHistory
			? [`${allRunning} active`, `${historyCount} history`]
			: allRunning > 0
				? [`${allRunning} active shell${allRunning === 1 ? "" : "s"}`]
				: ["No active shells"];
		if (unseenFailed) subtitleParts.push(`${unseenFailed} failed`);
		if (unseenStopped) subtitleParts.push(`${unseenStopped} stopped`);
		if (unseenDone) subtitleParts.push(`${unseenDone} done`);
		if (unread) subtitleParts.push(`${unread} unread`);
		const subtitle = subtitleParts.join(" · ");

		const body: string[] = [];
		if (tasks.length === 0) {
			const message = allTasks.length === 0
				? "  No background tasks in this session."
				: this.showHistory
					? "  No background tasks in this view."
					: "  No running background tasks. Press h to show recent history.";
			body.push(this.theme.fg("dim", message));
		} else {
			const maxNameWidth = Math.max(12, width - 78);
			const visible = tasks.slice(this.listScroll, this.listScroll + LIST_VISIBLE_ROWS);
			for (let i = 0; i < visible.length; i++) {
				const task = visible[i];
				if (!task) continue;
				const index = this.listScroll + i;
				const selected = index === this.selectedIndex;
				const pointer = selected ? "›" : " ";
				const unseen = task.status !== "running" && !this.options.isSeen(task.id);
				const unreadMark = unseen ? this.theme.fg("warning", "●") : " ";
				const rawName = truncateChars(taskDisplayName(task), maxNameWidth);
				const name = task.status === "failed"
					? this.theme.fg("error", rawName)
					: task.status === "killed"
						? this.theme.fg("warning", rawName)
						: task.status === "completed"
							? this.theme.fg("success", rawName)
							: this.theme.fg("text", rawName);
				const status = statusColor(this.theme, task.status, statusLabel(task.status));
				const runtime = taskAge(task);
				const size = formatSize(task.bytesWritten);
				const context = formatContextUsage(task);
				const contextText = ` ${contextColor(this.theme, task, `ctx ${context}`)}`;
				const model = formatModel(task);
				const modelText = model ? ` ${this.theme.fg("dim", model)}` : "";
				const tokenUsage = formatTokenUsage(task);
				const tokenText = tokenUsage ? ` ${this.theme.fg("dim", tokenUsage)}` : "";
				const toolUsage = formatToolUsage(task);
				const toolText = toolUsage ? ` ${this.theme.fg("dim", toolUsage)}` : "";
				const activity = this.activityLabel(task);
				const activityText = activity ? ` ${this.theme.fg("warning", activity)}` : "";
				const exit = task.exitCode !== undefined && task.status !== "running" ? this.theme.fg("dim", ` exit=${task.exitCode}`) : "";
				let row = ` ${pointer} ${unreadMark} ${name} ${this.theme.fg("dim", task.id)} ${this.theme.fg("dim", "·")} ${status}${exit} ${this.theme.fg("dim", `${runtime} ${size}`)}${contextText}${modelText}${tokenText}${toolText}${activityText}`;
				if (selected) {
					const selectedRow = padAnsi(truncateToWidth(row, width - 4), width - 4);
					row = `${this.theme.fg("accent", "▌")}${selectedRow.slice(1)}`;
				}
				body.push(row);
			}
			if (tasks.length > LIST_VISIBLE_ROWS) {
				body.push(this.theme.fg("dim", `  Showing ${this.listScroll + 1}-${Math.min(tasks.length, this.listScroll + LIST_VISIBLE_ROWS)} of ${tasks.length}`));
			}
		}
		if (this.actionMessage) body.push(this.theme.fg("warning", `  ${this.actionMessage}`));
		return this.frame(
			"bg tasks focused",
			subtitle,
			body,
			` ${this.theme.fg("dim", `↑/↓ select · Enter logs · k stop · a stop all · h ${this.showHistory ? "hide" : "show"} history · R rerun · c path · x close`)}`,
			width,
		);
	}

	private renderDetail(width: number): string[] {
		const task = this.detailTask();
		if (!task) {
			this.mode = "list";
			return this.renderList(width);
		}
		const name = taskDisplayName(task);
		const status = statusColor(this.theme, task.status);
		const exit = task.exitCode !== undefined ? ` exit=${task.exitCode}` : "";
		const fullDetails: string[] = [
			` ${this.theme.fg("toolTitle", "Name:")} ${this.theme.fg("accent", name)}`,
			` ${this.theme.fg("toolTitle", "ID:")} ${this.theme.fg("accent", task.id)}`,
			` ${this.theme.fg("toolTitle", "Status:")} ${status}${this.theme.fg("dim", exit)}`,
			` ${this.theme.fg("toolTitle", "Runtime:")} ${taskAge(task)}${task.pid ? this.theme.fg("dim", ` · pid ${task.pid}`) : ""}`,
			` ${this.theme.fg("toolTitle", "Started:")} ${formatTime(task.startTime)}${task.endTime ? this.theme.fg("dim", ` · ended ${formatTime(task.endTime)}`) : ""}`,
			` ${this.theme.fg("toolTitle", "Output:")} ${this.theme.fg("accent", task.outputPath)}`,
		];
		if (task.description && compactWhitespace(task.description) !== compactWhitespace(name)) {
			fullDetails.push(` ${this.theme.fg("toolTitle", "Description:")} ${truncateToWidth(task.description, width - 16)}`);
		}
		const modelDetail = formatModelDetail(task);
		fullDetails.push(` ${this.theme.fg("toolTitle", "Model:")} ${task.model ? this.theme.fg("accent", modelDetail) : this.theme.fg("dim", modelDetail)}`);
		const context = formatContextDetail(task);
		fullDetails.push(` ${this.theme.fg("toolTitle", "Context:")} ${contextColor(this.theme, task, context)}`);
		fullDetails.push(` ${this.theme.fg("toolTitle", "Tokens:")} ${this.theme.fg("dim", formatTokenDetail(task))}`);
		fullDetails.push(` ${this.theme.fg("toolTitle", "Tools:")} ${this.theme.fg("dim", formatToolDetail(task))}`);
		fullDetails.push(` ${this.theme.fg("toolTitle", "Command:")} ${truncateToWidth(task.command, width - 13)}`);
		if (task.error) fullDetails.push(` ${this.theme.fg("error", `Error: ${task.error}`)}`);

		const actionLines = this.actionMessage ? 1 : 0;
		const minRenderLines = FRAME_LINES + MIN_DETAIL_LINES + DETAIL_SEPARATOR_LINES + MIN_OUTPUT_LINES + OUTPUT_BOX_CHROME_LINES + actionLines;
		const maxBodyLines = Math.max(1, this.maxOverlayLines(minRenderLines) - FRAME_LINES);
		const fullOutputLines = DETAIL_VISIBLE_OUTPUT_LINES;
		const fullBodyLines = fullDetails.length + DETAIL_SEPARATOR_LINES + fullOutputLines + OUTPUT_BOX_CHROME_LINES + actionLines;
		let details = fullDetails;
		let outputLines = fullOutputLines;
		if (fullBodyLines > maxBodyLines) {
			const compactDetails = [
				` ${this.theme.fg("toolTitle", "Name:")} ${this.theme.fg("accent", name)} ${this.theme.fg("dim", "·")} ${status}${this.theme.fg("dim", exit)}`,
				` ${this.theme.fg("toolTitle", "Output:")} ${this.theme.fg("accent", task.outputPath)}`,
				` ${this.theme.fg("toolTitle", "Command:")} ${truncateToWidth(task.command, width - 13)}`,
			];
			if (task.error) compactDetails.splice(2, 0, ` ${this.theme.fg("error", `Error: ${task.error}`)}`);
			const detailBudget = Math.max(MIN_DETAIL_LINES, maxBodyLines - DETAIL_SEPARATOR_LINES - OUTPUT_BOX_CHROME_LINES - actionLines - MIN_OUTPUT_LINES);
			details = compactDetails.slice(0, detailBudget);
			outputLines = Math.max(MIN_OUTPUT_LINES, Math.min(fullOutputLines, maxBodyLines - details.length - DETAIL_SEPARATOR_LINES - OUTPUT_BOX_CHROME_LINES - actionLines));
		}

		const body: string[] = [...details, "", ` ${this.theme.fg("toolTitle", "Output tail:")}`, ...this.renderOutputBox(width - 4, outputLines)];
		if (this.actionMessage) body.push(this.theme.fg("warning", ` ${this.actionMessage}`));
		const subtitle = `${task.id} · ${task.status === "running" ? "live tail refreshes every second" : "final output"}`;
		const footer = ` ${this.theme.fg("dim", "↑/↓ scroll · ← list · r refresh · k stop · R rerun · c path · x close")}`;
		return this.frame(`bg: ${truncateChars(name, 64)}`, subtitle, body, footer, width);
	}

	private renderOutputBox(width: number, visibleOutputLines = DETAIL_VISIBLE_OUTPUT_LINES): string[] {
		const inner = Math.max(1, width - 2);
		const border = (value: string) => colorText(this.theme, BORDER_COLOR, value);
		const top = ` ${border(`╭${"─".repeat(inner)}╮`)}`;
		const bottom = ` ${border(`╰${"─".repeat(inner)}╯`)}`;
		const row = (content = "") => ` ${border("│")}${padAnsi(truncateToWidth(content, inner), inner)}${border("│")}`;
		const lines = [top];
		if (this.tailError) {
			lines.push(row(this.theme.fg("error", this.tailError)));
		} else if (this.detailLines.length === 0) {
			lines.push(row(this.theme.fg("dim", "No output yet")));
		} else {
			const maxTop = Math.max(0, this.detailLines.length - visibleOutputLines);
			const start = this.detailFollow ? maxTop : Math.min(this.detailScrollTop, maxTop);
			const windowLines = this.detailLines.slice(start, start + visibleOutputLines);
			for (const line of windowLines) lines.push(row(this.theme.fg("toolOutput", line)));
		}
		while (lines.length < visibleOutputLines + 1) lines.push(row());
		lines.push(bottom);
		lines.push(` ${this.theme.fg("dim", this.outputStatusLine(visibleOutputLines))}`);
		return lines;
	}

	private outputStatusLine(visibleOutputLines = DETAIL_VISIBLE_OUTPUT_LINES): string {
		const total = this.detailLines.length;
		if (!this.detailFollow && total > 0) {
			const maxTop = Math.max(0, total - visibleOutputLines);
			const start = Math.min(this.detailScrollTop, maxTop);
			const end = Math.min(total, start + visibleOutputLines);
			return `lines ${start + 1}\u2013${end} of ${total} · ↑/↓ PgUp/PgDn scroll · ↓ at bottom follows`;
		}
		const suffix = this.tailTruncated ? ` of ${formatSize(this.tailTotalBytes)}` : "";
		return `following tail ${formatSize(this.tailBytesRead)}${suffix} · ↑ scroll`;
	}
}

