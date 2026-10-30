#!/usr/bin/env node
// prove check     judge this checkout against the rules and laws on a base branch
// prove generate  turn a proven kernel into the TypeScript module an app imports
// prove gate      run only the TypeScript call-site checks, on this checkout

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkRepo, renderGithub, renderText } from "./check.ts";
import { parseConfig, type Rule } from "./config.ts";
import { runProofGate } from "./gate.ts";
import {
	type GeneratedKernel,
	generateKernel,
	staleFiles,
	writeKernel,
} from "./generate/bend.ts";
import {
	type GeneratedLeanKernel,
	generateLeanKernel,
	type LeanRuntime,
	staleLeanFiles,
	writeLeanKernel,
} from "./generate/lean.ts";

const USAGE = `usage:
  prove check [--base REF] [--repo DIR] [--allow-repo-execution]
              [--format text|json|github] [--fail-on never|failure|review]
  prove generate [KERNEL_DIR --entry NAME --backend bend|lean|lasm] [--repo DIR]
              [--runtime SPECIFIER] [--check]
  prove gate [--repo DIR]

check reports and exits 0 by default; --fail-on failure (or review) makes it block.
generate without a directory generates every kernel in prove.json that names an entry.`;

function readConfig(repo: string) {
	const file = path.join(repo, "prove.json");
	if (!existsSync(file)) throw new Error(`no prove.json in ${repo}`);
	return parseConfig(readFileSync(file, "utf8"));
}

// A runtime given as a path to runtime/index.ts implies its siblings.
function leanRuntime(runtime: string | undefined): LeanRuntime | undefined {
	if (!runtime) return undefined;
	const match = /^(.*)index\.(ts|js)$/.exec(runtime);
	if (!match)
		throw new Error(
			"--runtime for Lean kernels must end in index.ts or index.js",
		);
	const [, dir, ext] = match;
	return {
		core: runtime,
		lasm: `${dir}lasm.${ext}`,
		model: `${dir}model.${ext}`,
	};
}

interface Target {
	dir: string;
	entry: string;
	backend: Rule["backend"];
	proofType?: string;
}

function generate(
	targets: Target[],
	runtime: string | undefined,
	check: boolean,
): number {
	let status = 0;
	for (const target of targets) {
		let generated: GeneratedKernel | GeneratedLeanKernel;
		const proofType = target.proofType ? { proofType: target.proofType } : {};
		if (target.backend === "bend")
			generated = generateKernel({
				dir: target.dir,
				entry: target.entry,
				...(runtime ? { runtime } : {}),
				...proofType,
			});
		else {
			const lean = leanRuntime(runtime);
			generated = generateLeanKernel({
				dir: target.dir,
				entry: target.entry,
				backend: target.backend,
				...(lean ? { runtime: lean } : {}),
				...proofType,
			});
		}
		if (check) {
			const stale =
				target.backend === "bend"
					? staleFiles(target.dir, generated)
					: staleLeanFiles(target.dir, generated);
			if (stale.length) {
				console.error(
					`${generated.rule}: out of date or edited by hand: ${stale.join(", ")}`,
				);
				status = 1;
			} else
				console.log(`${generated.rule}: generated files match a fresh build`);
			continue;
		}
		const written =
			target.backend === "bend"
				? writeKernel(target.dir, generated)
				: writeLeanKernel(target.dir, generated);
		console.log(
			`${generated.rule}: wrote ${written.map((f) => path.join(target.dir, f)).join(", ")}`,
		);
	}
	return status;
}

export function main(argv: readonly string[]): number {
	const { positionals, values } = parseArgs({
		args: [...argv],
		allowPositionals: true,
		options: {
			repo: { type: "string", default: "." },
			base: { type: "string", default: "origin/main" },
			format: { type: "string", default: "text" },
			"fail-on": { type: "string", default: "never" },
			"allow-repo-execution": { type: "boolean", default: false },
			entry: { type: "string" },
			backend: { type: "string" },
			runtime: { type: "string" },
			check: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});
	const [command, ...rest] = positionals;
	if (values.help || !command) {
		console.log(USAGE);
		return values.help ? 0 : 2;
	}
	const repo = path.resolve(values.repo);
	try {
		if (command === "check" && rest.length === 0) {
			const format = values.format;
			const failOn = values["fail-on"];
			if (
				!["text", "json", "github"].includes(format) ||
				!["never", "failure", "review"].includes(failOn)
			) {
				console.error(USAGE);
				return 2;
			}
			const report = checkRepo(repo, values.base, {
				allowRepoExecution: values["allow-repo-execution"],
			});
			const text =
				format === "json"
					? `${JSON.stringify(report, null, 2)}\n`
					: format === "github"
						? renderGithub(report)
						: renderText(report);
			process.stdout.write(text);
			const summary = process.env.GITHUB_STEP_SUMMARY;
			if (format === "github" && summary)
				appendFileSync(
					summary,
					`## prove check\n\n\`\`\`\n${renderText(report)}\`\`\`\n`,
				);
			if (failOn === "failure" && report.verdict === "fail") return 1;
			if (failOn === "review" && report.verdict !== "pass") return 1;
			return 0;
		}
		if (command === "generate" && rest.length <= 1) {
			const [dir] = rest;
			if (dir) {
				const backend = values.backend ?? "bend";
				if (!values.entry || !["bend", "lean", "lasm"].includes(backend)) {
					console.error(USAGE);
					return 2;
				}
				return generate(
					[
						{
							dir: path.resolve(dir),
							entry: values.entry,
							backend: backend as Rule["backend"],
						},
					],
					values.runtime,
					values.check,
				);
			}
			const seen = new Set<string>();
			const targets: Target[] = [];
			for (const rule of readConfig(repo).rules)
				if (rule.entry && !seen.has(rule.kernel)) {
					seen.add(rule.kernel);
					targets.push({
						dir: path.join(repo, rule.kernel),
						entry: rule.entry,
						backend: rule.backend,
						...(rule.proofType ? { proofType: rule.proofType } : {}),
					});
				}
			if (!targets.length) {
				console.error("no rule in prove.json names an entry to generate");
				return 2;
			}
			return generate(targets, values.runtime, values.check);
		}
		if (command === "gate" && rest.length === 0) {
			let status = 0;
			for (const rule of readConfig(repo).rules) {
				if (!rule.gate) continue;
				const proof = rule.gate.proof ?? rule.proofType ?? "";
				const result = runProofGate(repo, { ...rule.gate, proof });
				console.log(
					`${result.ok ? "✓" : "✗"} ${rule.id}: ${result.ok ? `every call site holds ${proof}` : ""}`,
				);
				for (const problem of result.problems) console.log(`    ${problem}`);
				if (!result.ok) status = 1;
			}
			return status;
		}
		console.error(USAGE);
		return 2;
	} catch (error) {
		console.error(
			error instanceof Error
				? `${error.name}: ${error.message}`
				: String(error),
		);
		return 1;
	}
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
