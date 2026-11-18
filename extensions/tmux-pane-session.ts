/**
 * Pi side of tmux-pi-resurrect.
 *
 * Marks the tmux pane Pi runs in with its session: @pi-session-file (the
 * session's JSONL file) and @pi-pid (this process, so a save can tell a live
 * Pi from a stale mark). The marks follow /new, /resume, /fork, and /reload
 * and are removed when Pi quits, so a pane whose Pi was ended is not
 * restored. Only the interactive TUI marks its pane: subagents and `pi -p`
 * inherit TMUX_PANE from the Pi that started them.
 *
 * At startup it also sets up the tmux side of this package: it adds a line
 * that loads pi-resurrect.tmux to the tmux configuration, before
 * tmux-continuum (whose restore needs the hooks), and loads it into the
 * running tmux. What it cannot do it says once per tmux server, as a
 * warning, and leaves everything else as it is.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FILE_OPTION = "@pi-session-file";
const PID_OPTION = "@pi-pid";
/** Server option listing the notices already shown, so each shows once. */
const TOLD_OPTION = "@pi-resurrect-told";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "pi-resurrect.tmux");
/** Several Pi starting at once set up one after another. */
const LOCK_FILE = path.join(os.tmpdir(), `tmux-pi-resurrect-${process.getuid?.() ?? "user"}.lock`);

/** A line that loads this plugin, by the Pi extension or by hand (TPM). */
const PLUGIN_LINE = /pi-resurrect\.tmux|tmux-pi-resurrect/;
/** A line that loads tmux-continuum, directly or through TPM. */
const CONTINUUM_LINE = /continuum\.tmux|tmux-continuum|tpm\/tpm/;

function tmux(args: string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile("tmux", args, { timeout: 5000 }, (error, stdout) => resolve(error ? "" : String(stdout).trim()));
	});
}

const isCommand = (line: string) => line.trim() !== "" && !line.trim().startsWith("#");

/**
 * The user configuration the running tmux server read: the first regular
 * file of #{config_files} (tmux 3.2 and later list the files they tried),
 * else of the default places.
 */
async function configFile(): Promise<string | undefined> {
	const home = os.homedir();
	const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
	const listed = (await tmux(["display-message", "-p", "#{config_files}"])).split(",").filter(Boolean);
	const candidates = listed.length
		? listed.filter((file) => file !== "/etc/tmux.conf")
		: [path.join(home, ".tmux.conf"), path.join(xdg, "tmux", "tmux.conf"), path.join(home, ".config", "tmux", "tmux.conf")];
	return candidates.find((file) => {
		try {
			return fs.statSync(file).isFile();
		} catch {
			return false;
		}
	});
}

/** Inserts the loading block before tmux-continuum, else after the header. */
function withPlugin(text: string): string {
	const lines = text.split("\n");
	const block = [
		"# tmux-pi-resurrect: brings Pi sessions back with tmux-resurrect. Added by",
		"# its Pi extension; keep it before tmux-continuum, whose restore needs it.",
		`if-shell "test -f '${PLUGIN}'" "run-shell 'bash ${PLUGIN}'"`,
	];
	let at = lines.findIndex((line) => isCommand(line) && CONTINUUM_LINE.test(line));
	if (at < 0) at = lines.findIndex(isCommand);
	if (at < 0) at = lines.length;
	const before = at > 0 && lines[at - 1].trim() !== "" ? [""] : [];
	lines.splice(at, 0, ...before, ...block, "");
	return lines.join("\n");
}

/**
 * Writes beside the file and renames, keeping its mode; a symlink is
 * followed, a file without write permission is left alone (throws).
 */
function writeAtomic(file: string, text: string): void {
	const target = fs.realpathSync(file);
	fs.accessSync(target, fs.constants.W_OK);
	const temp = path.join(path.dirname(target), `.${path.basename(target)}.pi-resurrect-${process.pid}`);
	try {
		fs.writeFileSync(temp, text, { mode: fs.statSync(target).mode & 0o777 });
		fs.renameSync(temp, target);
	} finally {
		fs.rmSync(temp, { force: true });
	}
}

/** A lock whose holder is gone, or that stayed empty for half a minute. */
function staleLock(): boolean {
	try {
		const pid = Number(fs.readFileSync(LOCK_FILE, "utf8"));
		if (!pid) return Date.now() - fs.statSync(LOCK_FILE).mtimeMs > 30_000;
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/** Runs work under the lock; gives up after ten seconds without running it. */
async function locked(work: () => Promise<void>): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
			break;
		} catch {
			if (staleLock()) {
				fs.rmSync(LOCK_FILE, { force: true });
				continue;
			}
			if (Date.now() > deadline) return;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	try {
		await work();
	} finally {
		try {
			if (fs.readFileSync(LOCK_FILE, "utf8") === String(process.pid)) fs.rmSync(LOCK_FILE);
		} catch {
			// Already gone.
		}
	}
}

async function setUp(ctx: ExtensionContext): Promise<void> {
	if (!fs.existsSync(PLUGIN)) return;
	const told = new Set((await tmux(["show-option", "-gqv", TOLD_OPTION])).split(",").filter(Boolean));
	const tell = async (key: string, level: "info" | "warning", message: string) => {
		if (told.has(key)) return;
		told.add(key);
		ctx.ui.notify(`tmux-pi-resurrect: ${message}`, level);
		await tmux(["set-option", "-gq", TOLD_OPTION, [...told].join(",")]);
	};
	const manual = `add \`run-shell 'bash ${PLUGIN}'\` to your tmux configuration, before tmux-continuum.`;

	// The configuration: add the plugin, or check where it is loaded.
	const file = await configFile();
	if (!file) {
		await tell("config", "warning", `no tmux configuration found; ${manual}`);
	} else {
		try {
			const text = fs.readFileSync(file, "utf8");
			const lines = text.split("\n");
			const own = lines.findIndex((line) => isCommand(line) && PLUGIN_LINE.test(line));
			if (own < 0) {
				if (/['"\\$\n]/.test(PLUGIN)) throw new Error("unquotable path");
				writeAtomic(file, withPlugin(text));
				await tell("added", "info", `added to ${file}; Pi sessions in tmux now come back with tmux-resurrect.`);
			} else {
				const continuum = lines.findIndex((line) => isCommand(line) && CONTINUUM_LINE.test(line));
				if (continuum >= 0 && continuum < own) {
					await tell("order", "warning", `in ${file} it is loaded after tmux-continuum; move it before, else an automatic restore misses the Pi sessions.`);
				}
			}
		} catch {
			await tell("config", "warning", `could not change ${file}; ${manual}`);
		}
	}

	// The running server: the hooks, tmux-resurrect, and tmux-continuum.
	const hooks = [
		await tmux(["show-option", "-gqv", "@resurrect-hook-post-save-layout"]),
		await tmux(["show-option", "-gqv", "@resurrect-hook-pre-restore-pane-processes"]),
	];
	if (hooks.some((hook) => hook === "")) {
		await tmux(["run-shell", `bash '${PLUGIN.replace(/'/g, `'\\''`)}'`]);
	}
	const set = [
		await tmux(["show-option", "-gqv", "@resurrect-hook-post-save-layout"]),
		await tmux(["show-option", "-gqv", "@resurrect-hook-pre-restore-pane-processes"]),
	];
	if (set.some((hook) => !hook.includes("pi-resurrect"))) {
		await tell("hooks", "warning", "the tmux-resurrect hooks post-save-layout or pre-restore-pane-processes run other commands; call its scripts from them (see its README).");
	}
	if (!(await tmux(["show-option", "-gqv", "@resurrect-restore-script-path"]))) {
		await tell("resurrect", "warning", "tmux-resurrect is not loaded in this tmux; install it, else Pi sessions are neither saved nor restored.");
	} else if (
		!(await tmux(["show-option", "-gqv", "@continuum-save-last-timestamp"])) &&
		!(await tmux(["show-option", "-gqv", "status-right"])).includes("continuum")
	) {
		await tell("continuum", "warning", "tmux-continuum is not active in this tmux; Pi sessions come back only with a restore by hand (prefix + Ctrl-r).");
	}
}

export default function (pi: ExtensionAPI) {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return;

	const mark = (file: string) =>
		tmux([
			"set-option", "-p", "-t", pane, FILE_OPTION, file, ";",
			"set-option", "-p", "-t", pane, PID_OPTION, String(process.pid),
		]);
	const unmark = () =>
		tmux([
			"set-option", "-p", "-u", "-t", pane, FILE_OPTION, ";",
			"set-option", "-p", "-u", "-t", pane, PID_OPTION,
		]);

	pi.on("session_start", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const file = ctx.sessionManager.getSessionFile();
		await (file ? mark(file) : unmark());
		if (event.reason === "startup" || event.reason === "reload") {
			void locked(() => setUp(ctx)).catch(() => undefined);
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (ctx.mode !== "tui" || event.reason !== "quit") return;
		await unmark();
	});
}
