import { cpSync, lstatSync } from "node:fs";

export type BackendId = "bend" | "lean" | "lasm";

// What one backend run is asked to establish. The laws come from the base
// branch, so a PR is always judged by the statements its owner approved.
export interface KernelJob {
	// The PR's kernel directory (the one holding the proof file).
	cwd: string;
	// The laws file's text on the base branch.
	baseLaws: string;
	// The kernel directory's source files on the base branch, by path relative
	// to it, so a backend can check the laws still mean what was approved.
	baseSources: Record<string, string>;
	// Bare law name, as returned by `bind`.
	law: string;
	// The compiled kernel the app imports, or null when the rule names none.
	// Empty when the rule names one that the PR deleted.
	generated: Buffer | null;
}

export interface KernelRun {
	exitCode: number | null;
	output: string;
	// Set when the backend could not run at all (missing tool, timeout).
	error?: string;
	stage?: "proof" | "compiled";
}

export interface ProofBackend {
	id: BackendId;
	name: string;
	// File names inside the kernel directory. The laws file is always read
	// from the base branch; editing either one needs owner approval.
	lawsFile: string;
	proofFile: string;
	// Extension of the kernel's source files.
	sourceExtension: string;
	// Other kernel files that are trusted rather than proved, so a change to
	// them needs owner approval too.
	adapterFiles: string[];
	// Checking the proof elaborates PR-authored code that can run arbitrary
	// programs, so it needs repository-execution consent.
	executesRepoCode: boolean;
	// Whether a pass covers code the app runs, or only a model of it.
	passLabel: "KERNEL PROVEN" | "MODEL PROVEN";
	// Appended to a pass: exactly what the pass does and does not cover.
	scope: string;
	// The bare law name when the proof and base laws both define it, else null.
	bind(law: string, proofText: string, baseLaws: string): string | null;
	// Human-readable proof command, for the report.
	command(): string;
	run(job: KernelJob): KernelRun;
}

// Splits an override like "bun /path/to/bend2/main.ts" into command and args.
// PROVE_<TOOL> wins; TOUCHWARDEN_<TOOL> is read for older setups.
export function commandFrom(
	tool: string,
	fallback: string,
): [string, string[]] {
	const parts = (
		process.env[`PROVE_${tool}`] ||
		process.env[`TOUCHWARDEN_${tool}`] ||
		fallback
	)
		.trim()
		.split(/\s+/);
	return [parts[0] as string, parts.slice(1)];
}

// Copies only regular source files with `extension`, so repo-owned .env,
// package scripts, preloads and build files never reach the trusted tool.
export function stageSources(from: string, to: string, extension: string) {
	cpSync(from, to, {
		recursive: true,
		filter: (source) => {
			const stat = lstatSync(source);
			if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
				throw new Error(
					"Unsupported symlink/special file in kernel source tree",
				);
			return stat.isDirectory() || source.endsWith(extension);
		},
	});
}
