// `prove check`: judges the checked-out code against the rules and laws on
// the base branch. Everything that decides the verdict (prove.json, each
// laws file, each gate's trusted files) is read from base, so a PR is judged
// by what its owner approved and not by what it edits.
//
// It reports by default. Callers choose what blocks: see `failOn`.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { backends } from "./backends/index.ts";
import { type Config, parseConfig, type Rule } from "./config.ts";
import { type GateResult, runProofGate } from "./gate.ts";
import { safeGit } from "./git.ts";

export type Verdict = "pass" | "review" | "fail" | "skipped";

export interface RuleReport {
	id: string;
	statement: string;
	backend: Rule["backend"];
	/** Did the law hold for this code? */
	proof: {
		verdict: "proven" | "model-proven" | "failed" | "skipped";
		command: string;
		detail: string;
		output: string;
	};
	/** Does every call site hold the kernel's approval? */
	gate?: { verdict: "pass" | "fail"; problems: string[] };
	/** Files a person must look at: laws, proofs, adapters and gate files this PR edits. */
	review: string[];
	verdict: Verdict;
}

export interface Report {
	base: string;
	rules: RuleReport[];
	/** prove.json changed in this PR; the rules above are the base ones. */
	configChanged: boolean;
	/** incomplete: nothing failed or needs review, but some proofs did not run. */
	verdict: "pass" | "review" | "fail" | "incomplete";
}

export interface CheckOptions {
	/** Lean and Lasm checks elaborate repository code; they only run with this. */
	allowRepoExecution?: boolean;
	/** Overridable for tests; defaults to process.env. */
	env?: NodeJS.ProcessEnv;
}

const SUPPRESSION = /@ts-(?:ignore|expect-error|nocheck)\b/;

export function checkRepo(
	repoInput: string,
	base: string,
	options: CheckOptions = {},
): Report {
	if (!base || base.startsWith("-")) throw new Error("Invalid base ref");
	const env = options.env ?? process.env;
	const repo = realpathSync(repoInput);
	const root = realpathSync(
		safeGit(repo, ["rev-parse", "--show-toplevel"]).trim(),
	);
	const prefix = path.relative(root, repo).split(path.sep).join("/");
	const at = (file: string) => (prefix ? `${prefix}/${file}` : file);
	const baseCommit = safeGit(root, [
		"rev-parse",
		"--verify",
		`${base}^{commit}`,
	]).trim();
	const fromBase = (file: string): string | null => {
		try {
			return safeGit(root, ["show", `${baseCommit}:${at(file)}`]);
		} catch {
			return null;
		}
	};
	const baseConfigText = fromBase("prove.json");
	if (baseConfigText === null)
		throw new Error(
			`No prove.json on ${base}. Commit the rules to the base branch first: a PR is judged by the rules there.`,
		);
	const config: Config = parseConfig(baseConfigText);
	const headConfig = path.join(repo, "prove.json");
	const configChanged =
		!existsSync(headConfig) ||
		readFileSync(headConfig, "utf8") !== baseConfigText;
	// Files this PR changes (committed and not), relative to the repo.
	const changed = new Set(
		safeGit(root, ["diff", "--name-only", baseCommit, "--", prefix || "."])
			.split("\n")
			.filter(Boolean)
			.map((file) => (prefix ? file.slice(prefix.length + 1) : file)),
	);
	const addedLines = safeGit(root, [
		"diff",
		"-U0",
		baseCommit,
		"--",
		prefix || ".",
	])
		.split("\n")
		.filter((line) => line.startsWith("+") && !line.startsWith("+++"));
	const pullRequestTarget = env.GITHUB_EVENT_NAME === "pull_request_target";

	const rules = config.rules.map((rule): RuleReport => {
		const backend = backends[rule.backend];
		const review = [
			`${rule.kernel}/${backend.lawsFile}`,
			`${rule.kernel}/${backend.proofFile}`,
			...backend.adapterFiles.map((file) => `${rule.kernel}/${file}`),
			...(rule.gate?.trusted ?? []),
		].filter((file) => changed.has(file));
		if (configChanged) review.push("prove.json");

		let proof: RuleReport["proof"];
		const command = `${backend.command()} (laws from ${base})${rule.generated ? " + compiled kernel freshness" : ""}`;
		const skip = (detail: string) => ({
			verdict: "skipped" as const,
			command,
			detail,
			output: "",
		});
		const baseLaws = fromBase(`${rule.kernel}/${backend.lawsFile}`);
		const proofFile = path.join(repo, rule.kernel, backend.proofFile);
		const bound =
			baseLaws !== null && existsSync(proofFile)
				? backend.bind(rule.law, readFileSync(proofFile, "utf8"), baseLaws)
				: null;
		if (backend.executesRepoCode && pullRequestTarget)
			proof = skip(
				`${backend.name} proofs run repository code, and pull_request_target runs with write access and secrets. Use the pull_request event.`,
			);
		else if (backend.executesRepoCode && !options.allowRepoExecution)
			proof = skip(
				`Checking a ${backend.name} proof elaborates repository code, which can run programs. Pass --allow-repo-execution on a disposable runner to check it.`,
			);
		else if (baseLaws === null || bound === null)
			proof = skip(
				`Law ${rule.law} was not found in ${rule.kernel}/${backend.lawsFile} on ${base} and ${rule.kernel}/${backend.proofFile} here.`,
			);
		else {
			const kernelPath = at(rule.kernel);
			const baseSources: Record<string, string> = {};
			for (const file of safeGit(root, [
				"ls-tree",
				"-r",
				"--name-only",
				baseCommit,
				"--",
				`${kernelPath}/`,
			])
				.split("\n")
				.filter((file) => file.endsWith(backend.sourceExtension)))
				baseSources[file.slice(kernelPath.length + 1)] = safeGit(root, [
					"show",
					`${baseCommit}:${file}`,
				]);
			const generatedFile = rule.generated
				? path.join(repo, rule.generated)
				: null;
			const run = backend.run({
				cwd: path.dirname(proofFile),
				baseLaws,
				baseSources,
				law: bound,
				generated: generatedFile
					? existsSync(generatedFile)
						? readFileSync(generatedFile)
						: Buffer.alloc(0)
					: null,
			});
			const output = run.output.slice(-4000);
			if (run.error)
				proof = {
					...skip(`${backend.name} could not run: ${run.error}`),
					output,
				};
			else if (run.exitCode === 0)
				proof = {
					verdict:
						backend.passLabel === "MODEL PROVEN" ? "model-proven" : "proven",
					command,
					detail: `${rule.law} holds against the laws on ${base}; ${backend.scope}`,
					output,
				};
			else
				proof = {
					verdict: "failed",
					command,
					detail:
						run.stage === "compiled"
							? `The compiled kernel the app runs (${rule.generated}) is not a fresh build of the proven source; the proof itself passed.`
							: `${rule.law} does not hold against the laws on ${base}; see the output.`,
					output,
				};
		}

		let gate: RuleReport["gate"];
		if (rule.gate) {
			// The trusted list comes from base too: a PR cannot trust its own file.
			const proofType = rule.gate.proof ?? rule.proofType ?? "";
			const result: GateResult = runProofGate(repo, {
				...rule.gate,
				proof: proofType,
			});
			const projectPrefix =
				rule.gate.project === "."
					? ""
					: `${rule.gate.project.replace(/\/$/, "")}/`;
			const suppressions = addedLines.filter((line) => SUPPRESSION.test(line));
			const problems = [
				...result.problems,
				...(suppressions.length &&
				[...changed].some((file) => file.startsWith(projectPrefix))
					? [
							`This change adds a TypeScript suppression comment; it can hide a missing ${proofType}.`,
						]
					: []),
			];
			gate = { verdict: problems.length ? "fail" : "pass", problems };
		}

		const verdict: Verdict =
			proof.verdict === "failed" || gate?.verdict === "fail"
				? "fail"
				: review.length
					? "review"
					: proof.verdict === "skipped"
						? "skipped"
						: "pass";
		return {
			id: rule.id,
			statement: rule.statement,
			backend: rule.backend,
			proof,
			...(gate ? { gate } : {}),
			review,
			verdict,
		};
	});
	const verdict = rules.some((r) => r.verdict === "fail")
		? "fail"
		: rules.some((r) => r.verdict === "review") || configChanged
			? "review"
			: rules.some((r) => r.verdict === "skipped")
				? "incomplete"
				: "pass";
	return { base, rules, configChanged, verdict };
}

const ICON: Record<Verdict, string> = {
	pass: "✓",
	review: "?",
	fail: "✗",
	skipped: "-",
};

export function renderText(report: Report): string {
	const lines = [
		`prove check against ${report.base}: ${report.verdict.toUpperCase()}`,
	];
	if (report.configChanged)
		lines.push(
			"  prove.json changed in this PR; the rules below are the ones on base.",
		);
	for (const rule of report.rules) {
		lines.push(
			"",
			`${ICON[rule.verdict]} ${rule.id} (${rule.backend}): ${rule.statement}`,
		);
		lines.push(`  proof: ${rule.proof.verdict}. ${rule.proof.detail}`);
		if (rule.gate)
			lines.push(
				`  gate: ${rule.gate.verdict}${rule.gate.problems.length ? "" : ". Every call site holds the approval."}`,
				...rule.gate.problems.map((p) => `    ${p}`),
			);
		if (rule.review.length)
			lines.push(`  needs review: ${rule.review.join(", ")}`);
		if (rule.proof.verdict === "failed" && rule.proof.output)
			lines.push(
				...rule.proof.output
					.trimEnd()
					.split("\n")
					.slice(-12)
					.map((l) => `    | ${l}`),
			);
	}
	return `${lines.join("\n")}\n`;
}

/** GitHub workflow commands: one annotation per problem, readable without a token. */
export function renderGithub(report: Report): string {
	const encode = (s: string) =>
		s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
	const out: string[] = [];
	for (const rule of report.rules) {
		if (rule.proof.verdict === "failed")
			out.push(`::error title=${rule.id}::${encode(rule.proof.detail)}`);
		for (const problem of rule.gate?.problems ?? []) {
			const match = /^([^:\s]+):(\d+): (.*)$/s.exec(problem);
			out.push(
				match
					? `::error file=${match[1]},line=${match[2]},title=${rule.id}::${encode(match[3] ?? "")}`
					: `::error title=${rule.id}::${encode(problem)}`,
			);
		}
		if (rule.review.length)
			out.push(
				`::warning title=${rule.id}::${encode(`Needs review: ${rule.review.join(", ")}`)}`,
			);
		if (rule.proof.verdict === "skipped")
			out.push(`::notice title=${rule.id}::${encode(rule.proof.detail)}`);
	}
	return `${out.join("\n")}${out.length ? "\n" : ""}${renderText(report)}`;
}
