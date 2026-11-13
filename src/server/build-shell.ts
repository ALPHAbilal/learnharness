/**
 * Which shell a build branch uses, and how to stop what it started
 * (docs/superpowers/specs/2026-11-13-workspace-practice-branch-design.md).
 *
 * Windows: WSL bash when wsl.exe is present, otherwise PowerShell. Linux and
 * macOS: bash. `LH_BUILD_SHELL` (wsl | powershell | bash) overrides.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type BuildShellKind = "bash" | "wsl" | "powershell";

export function buildShellKind(): BuildShellKind {
	const override = process.env.LH_BUILD_SHELL;
	if (override === "bash" || override === "wsl" || override === "powershell") return override;
	if (process.platform !== "win32") return "bash";
	const wsl = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe");
	return fs.existsSync(wsl) ? "wsl" : "powershell";
}

export function shellLabel(kind: BuildShellKind = buildShellKind()): string {
	return kind === "wsl" ? "WSL bash" : kind === "powershell" ? "PowerShell" : "bash";
}

/** The environment build commands run with: the server's, plus a plain
 *  terminal type and Python's unbuffered output (prints show up live). */
function shellEnv(): NodeJS.ProcessEnv {
	return { ...process.env, TERM: "xterm-256color", PYTHONUNBUFFERED: "1", FORCE_COLOR: "1" };
}

export interface SpawnSpec {
	file: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

/** A non-interactive `run this command in the folder` spawn. */
export function shellCommandSpec(folder: string, command: string, kind: BuildShellKind = buildShellKind()): SpawnSpec {
	const env = shellEnv();
	if (kind === "wsl") return { file: "wsl.exe", args: ["--cd", folder, "--", "bash", "-lc", command], cwd: folder, env };
	if (kind === "powershell") return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command], cwd: folder, env };
	return { file: "bash", args: ["-lc", command], cwd: folder, env };
}

/** The learner's interactive shell in the folder. */
export function interactiveShellSpec(folder: string, kind: BuildShellKind = buildShellKind()): SpawnSpec {
	const env = shellEnv();
	if (kind === "wsl") return { file: "wsl.exe", args: ["--cd", folder], cwd: folder, env };
	if (kind === "powershell") return { file: "powershell.exe", args: ["-NoLogo"], cwd: folder, env };
	return { file: "bash", args: ["-l"], cwd: folder, env };
}

/** Kill a process and everything it started. POSIX children are spawned
 *  detached (their own process group); Windows uses taskkill /T. */
export function killProcessTree(pid: number | undefined): void {
	if (!pid) return;
	try {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
		} else {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				process.kill(pid, "SIGKILL");
			}
		}
	} catch {
		/* already gone */
	}
}
