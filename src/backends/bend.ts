import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	commandFrom,
	type KernelJob,
	type KernelRun,
	type ProofBackend,
	stageSources,
} from "./backend.ts";

// PROVE_BEND overrides the Bend command, e.g. "bun /path/to/bend2/main.ts".
export const bendCommand = () => commandFrom("BEND", "bend");

// Proves the PR's kernel against the base branch's LAWS.bend, so a PR cannot
// weaken the laws it is judged by, then checks the compiled kernel the app
// imports is a fresh emit of that source.
function runBend({ cwd, baseLaws, generated }: KernelJob): KernelRun {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "prove-bend-"));
	try {
		stageSources(cwd, tmp, ".bend");
		writeFileSync(path.join(tmp, "LAWS.bend"), baseLaws);
		const [cmd, args] = bendCommand();
		const run = (extra: string[]) =>
			spawnSync(cmd, [...args, ...extra], {
				cwd: tmp,
				encoding: "utf8",
				timeout: 60_000,
				maxBuffer: 2_000_000,
				env: {
					...process.env,
					BEND_NO_TELEMETRY: "1",
					BEND_TELEMETRY: "0",
					DO_NOT_TRACK: "1",
					// Hub imports in PR code must not reach the network or the runner's home.
					BEND_HUB: "http://127.0.0.1:9",
					BEND_LIB: path.join(tmp, ".bend-lib"),
				},
			});
		const proof = run(["PROOF.bend", "--check-only"]);
		const output = `${proof.stdout || ""}${proof.stderr || ""}`;
		if (proof.error)
			return { exitCode: null, output, error: proof.error.message };
		// Bend 2.0.32+ prints this verdict only when no proof relies on @unsafe or
		// foreign code. Older Bend exits 0 on those, so it fails here instead.
		if (proof.status !== 0 || !/^ALL PROOFS CHECK$/m.test(output))
			return { exitCode: proof.status || 1, output, stage: "proof" };
		if (generated === null) return { exitCode: 0, output, stage: "proof" };
		// Compile the code the laws are about: the first local file LAWS.bend imports.
		const entry = /import \.\/([\w.-]+\.bend) as/.exec(baseLaws)?.[1];
		if (!entry || !existsSync(path.join(tmp, entry)))
			return {
				exitCode: 1,
				output: `${output}\nLAWS.bend imports no local kernel file to compile.`,
				stage: "compiled",
			};
		const mjs = path.join(tmp, "emitted.mjs");
		const emit = run([entry, "-o", mjs]);
		if (emit.status !== 0 || !existsSync(mjs))
			return {
				exitCode: 1,
				output: `${output}\n${emit.stdout || ""}${emit.stderr || ""}`,
			};
		const code = readFileSync(mjs, "utf8");
		const app = generated.toString("utf8");
		// The file must be header comments, then Bend's ES module byte for byte.
		// The module's own export object names what the app can call, so nothing
		// may follow it and nothing but comments may precede it.
		const header = app.endsWith(code)
			? app.slice(0, app.length - code.length)
			: null;
		if (
			header === null ||
			!header.split("\n").every((line) => line === "" || line.startsWith("//"))
		)
			return {
				exitCode: 1,
				output: `${output}\nThe compiled kernel the app imports does not match a fresh compile of the proven source.`,
				stage: "compiled",
			};
		return { exitCode: 0, output };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

export const bend: ProofBackend = {
	id: "bend",
	name: "Bend",
	lawsFile: "LAWS.bend",
	proofFile: "PROOF.bend",
	sourceExtension: ".bend",
	adapterFiles: [],
	executesRepoCode: false,
	passLabel: "KERNEL PROVEN",
	scope: "only the Bend kernel is verified.",
	bind(law, proofText, baseLaws) {
		const name = law.replace(/^Laws\./, "");
		if (
			!/^[a-z][a-z0-9_]*$/.test(name) ||
			!baseLaws.includes(`law ${name}:`) ||
			!proofText.includes(`def Laws.${name}(`) ||
			!proofText.includes("import ./LAWS.bend as Laws")
		)
			return null;
		return name;
	},
	command() {
		const [cmd, args] = bendCommand();
		return `${[cmd, ...args].join(" ")} PROOF.bend --check-only`;
	},
	run: runBend,
};
