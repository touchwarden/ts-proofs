import { execFileSync } from "node:child_process";
import os from "node:os";

/** Local-only Git: no routing overrides, replacement objects, lazy fetches, fsmonitor or diff helpers. */
export function safeGit(
	repo: string,
	args: string[],
	indexFile?: string,
	input?: Buffer,
): string {
	return safeGitBytes(repo, args, indexFile, input).toString("utf8");
}

export function safeGitBytes(
	repo: string,
	args: string[],
	indexFile?: string,
	input?: Buffer,
): Buffer {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
	);
	return execFileSync(
		"git",
		[
			"--no-replace-objects",
			"-c",
			"protocol.allow=never",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.untrackedCache=false",
			"-c",
			`core.hooksPath=${os.devNull}`,
			"-c",
			"commit.gpgSign=false",
			"-c",
			"tag.gpgSign=false",
			"-c",
			"diff.submodule=short",
			"-C",
			repo,
			...(args[0] && ["diff", "log", "show"].includes(args[0])
				? [args[0], "--no-ext-diff", "--no-textconv", ...args.slice(1)]
				: args),
		],
		{
			input,
			maxBuffer: 64 << 20,
			timeout: 30_000,
			env: {
				...env,
				GIT_NO_LAZY_FETCH: "1",
				GIT_TERMINAL_PROMPT: "0",
				GIT_OPTIONAL_LOCKS: "0",
				GIT_LITERAL_PATHSPECS: "1",
				...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
			},
			stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
		},
	);
}

/** Refuse active executable Git filters before status/add can run them. Configuration alone is not consent. */
export function assertNoExecutableGitFilters(repo: string): void {
	let config: string;
	try {
		config = safeGit(repo, [
			"config",
			"--null",
			"--get-regexp",
			"^filter\\..*\\.(clean|smudge|process)$",
		]);
	} catch (error) {
		if ((error as { status?: number }).status === 1) return;
		throw error;
	}
	const drivers = new Set<string>();
	for (const entry of config.split("\0")) {
		const split = entry.indexOf("\n");
		if (split < 0 || !entry.slice(split + 1).trim()) continue;
		const match = /^filter\.(.+)\.(?:clean|smudge|process)$/.exec(
			entry.slice(0, split),
		);
		if (match?.[1]) drivers.add(match[1]);
	}
	if (!drivers.size) return;
	const files = safeGit(repo, [
		"ls-files",
		"--cached",
		"--others",
		"--exclude-standard",
		"-z",
	]);
	const attributes = safeGit(
		repo,
		["check-attr", "-z", "--stdin", "filter"],
		undefined,
		Buffer.from(files),
	).split("\0");
	for (let i = 0; i + 2 < attributes.length; i += 3)
		if (drivers.has(attributes[i + 2] as string))
			throw new Error(
				"Executable Git filters are active in this repository; no check or snapshot performed. Use a separately reviewed isolated checkout; ordinary checks do not authorise repository helpers.",
			);
}
