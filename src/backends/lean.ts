import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
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

// PROVE_LEAN overrides the Lean command; leanchecker is found beside
// the real binary, so it is always the same toolchain's.
export const leanCommand = () => commandFrom("LEAN", "lean");
// PROVE_LASM overrides the Lasm command, e.g. "node /path/to/lasm.mjs".
export const lasmCommand = () => commandFrom("LASM", "lasm");

// The standard axioms. `sorryAx`, native_decide's auxiliary axioms and any
// axiom the PR declares fail the gate.
const ALLOWED_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);

// Commands that run code, change how later files parse, or switch off kernel
// checking. This is defence in depth: the verdict comes from leanchecker and
// the audit program below, never from output PR code could print.
const FORBIDDEN =
	/(?<![\w.'])(#eval|#exit|run_cmd|run_elab|run_meta|macro|macro_rules|syntax|declare_syntax_cat|elab|elab_rules|command_elab|term_elab|tactic|init|builtin_init|notation|infix|infixl|infixr|prefix|postfix|initialize|builtin_initialize|set_option|unsafe|extern|implemented_by|prelude|module|meta|public)(?![\w'!?])/;
// Top-level names a local module may not take, so it cannot stand in for the
// toolchain's libraries.
const RESERVED = new Set(["Init", "Std", "Lean", "Lake"]);

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TIMEOUT = 120_000;

// Run with `lean --run` on Touchwarden's own copy. It loads the compiled
// modules without running any of their code and prints, for the law: whether
// Proofs.<law> has exactly the type Laws.<law>, its axioms, and a fingerprint
// of what the law means (its statement plus every local type, instance and
// constant it relies on, except kernel function bodies, which may change).
const AUDIT = `import Lean
open Lean

partial def erase : Expr → Expr
  | .forallE _ t b i => .forallE .anonymous (erase t) (erase b) i
  | .lam _ t b i => .lam .anonymous (erase t) (erase b) i
  | .letE _ t v b n => .letE .anonymous (erase t) (erase v) (erase b) n
  | .app f a => .app (erase f) (erase a)
  | .mdata _ e => erase e
  | .proj s i e => .proj s i (erase e)
  | e => e

partial def returnsSort : Expr → Bool
  | .forallE _ _ b _ => returnsSort b
  | .sort _ => true
  | _ => false

def main (args : List String) : IO UInt32 := do
  let [dir, module, laws, locals] := args | return 2
  let localMods := (locals.splitOn ",").map String.toName
  initSearchPath (← findSysroot) [dir]
  let env ← importModules #[{ module := module.toName }] {} (trustLevel := 0)
  let isLocal (c : Name) : Bool := match env.getModuleIdxFor? c with
    | some i => localMods.contains (env.header.moduleNames[i.toNat]!)
    | none => false
  for law in laws.splitOn "," do
    IO.println s!"law {law}"
    let lawName := (\`Laws).str law
    let proofName := (\`Proofs).str law
    if module != "Laws" then
      match env.find? proofName with
      | none => IO.println "proof missing"
      | some info =>
        IO.println s!"proof-type {info.type == .const lawName []}"
        let (axioms, _) ← (collectAxioms proofName : CoreM _).toIO { fileName := "", fileMap := default } { env }
        IO.println s!"axioms {",".intercalate (axioms.toList.map toString)}"
    IO.println "meaning"
    let mut seen : NameSet := {}
    let mut todo := [lawName]
    while true do
      let c :: rest := todo | break
      todo := rest
      if seen.contains c then continue
      seen := seen.insert c
      let some info := env.find? c | do IO.println s!"missing {c}"; continue
      IO.println s!"const {c} : {repr (erase info.type)}"
      let pinned := c == lawName || returnsSort info.type || Meta.isInstanceCore env c
      let mut refs := info.type.getUsedConstants.toList
      match info with
      | .defnInfo d =>
        if pinned then
          IO.println s!"value {c} := {repr (erase d.value)}"
          refs := refs ++ d.value.getUsedConstants.toList
      | .inductInfo i =>
        IO.println s!"inductive {c} {i.numParams} {i.numIndices} {i.ctors}"
        refs := refs ++ i.ctors
      | .opaqueInfo _ => IO.println s!"opaque {c}"
      | .axiomInfo _ => IO.println s!"axiom {c}"
      | _ => pure ()
      todo := todo ++ refs.filter isLocal
  return 0
`;

function modules(root: string, dir = ""): string[] {
	return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(
		(entry) => {
			const rel = path.posix.join(dir, entry.name);
			if (entry.isDirectory()) return modules(root, rel);
			if (!entry.name.endsWith(".lean")) return [];
			return [rel.slice(0, -".lean".length).split("/").join(".")];
		},
	);
}

export const fileOf = (root: string, module: string) =>
	path.join(root, `${module.split(".").join("/")}.lean`);

// Local modules `entry` depends on, dependencies first. Only the toolchain's
// own Init and Std may be imported besides these.
function buildOrder(root: string, entry: string): string[] | string {
	const local = new Set(modules(root));
	for (const module of local)
		if (RESERVED.has(module.split(".")[0] as string))
			return `${module}.lean takes a name reserved for the Lean toolchain.`;
	const order: string[] = [];
	const state = new Map<string, "visiting" | "done">();
	const visit = (module: string): string | null => {
		if (state.get(module) === "done") return null;
		if (state.get(module) === "visiting") return `Import cycle at ${module}.`;
		state.set(module, "visiting");
		const text = readFileSync(fileOf(root, module), "utf8");
		const forbidden = FORBIDDEN.exec(text)?.[1];
		if (forbidden)
			return `${module}.lean uses \`${forbidden}\`, which kernel proofs may not use.`;
		for (const line of text.split("\n")) {
			if (!/(?<![\w.'])import(?![\w'!?])/.test(line)) continue;
			// One plain import per line, nothing else on it, not even a comment.
			const name = /^import ([A-Za-z_][\w.]*)$/.exec(line.trimEnd())?.[1];
			if (!name)
				return `${module}.lean: write each import alone on its own line (\`${line.trim()}\`).`;
			if (local.has(name)) {
				const problem = visit(name);
				if (problem) return problem;
			} else if (!/^(?:Init|Std)(?:\.|$)/.test(name))
				return `${module}.lean imports ${name}; only local modules, Init and Std are allowed.`;
		}
		state.set(module, "done");
		order.push(module);
		return null;
	};
	if (!local.has(entry)) return `${entry}.lean is missing.`;
	return visit(entry) ?? order;
}

// The toolchain directory of the configured Lean, resolved outside the PR tree
// so a PR's lean-toolchain file cannot pick the compiler.
export function toolchain(): { lean: string; checker: string } | string {
	const [cmd, args] = leanCommand();
	const empty = mkdtempSync(path.join(os.tmpdir(), "prove-lean-"));
	try {
		const run = spawnSync(cmd, [...args, "--print-prefix"], {
			cwd: empty,
			encoding: "utf8",
			timeout: 30_000,
		});
		if (run.error) return run.error.message;
		const prefix = run.stdout.trim();
		const lean = path.join(prefix, "bin", "lean");
		const checker = path.join(prefix, "bin", "leanchecker");
		if (run.status !== 0 || !existsSync(lean) || !existsSync(checker))
			return `Lean toolchain not found (${cmd} --print-prefix).`;
		return { lean, checker };
	} finally {
		rmSync(empty, { recursive: true, force: true });
	}
}

export type Tools = { lean: string; checker: string };
export type Step = { ok: true; output: string; order: string[] } | KernelRun;

export function spawn(tools: Tools, cwd: string, cmd: string, args: string[]) {
	const run = spawnSync(cmd, args, {
		cwd,
		encoding: "utf8",
		timeout: TIMEOUT,
		maxBuffer: 8_000_000,
		// No inherited environment: elaboration runs repository code.
		// leanchecker starts `lean` from PATH, so the toolchain's bin comes first.
		env: {
			LEAN_PATH: cwd,
			HOME: cwd,
			PATH: `${path.dirname(tools.lean)}:/usr/bin:/bin`,
		},
	});
	return { run, text: `${run.stdout || ""}${run.stderr || ""}` };
}

// Compiles `entry` and the local modules it imports; with `replay`, re-checks
// every declaration with leanchecker, because elaboration can skip the kernel.
export function build(
	tools: Tools,
	dir: string,
	entry: string,
	replay: boolean,
): Step {
	rmSync(path.join(dir, "lakefile.lean"), { force: true });
	const order = buildOrder(dir, entry);
	if (typeof order === "string")
		return { exitCode: 1, output: order, stage: "proof" };
	let output = "";
	for (const module of order) {
		const file = fileOf(dir, module);
		const compile = spawn(tools, dir, tools.lean, [
			"-o",
			file.replace(/\.lean$/, ".olean"),
			file,
		]);
		output += compile.text;
		if (compile.run.error)
			return { exitCode: null, output, error: compile.run.error.message };
		if (compile.run.status !== 0)
			return { exitCode: compile.run.status || 1, output, stage: "proof" };
	}
	if (replay)
		for (const module of order) {
			const check = spawn(tools, dir, tools.checker, [module]);
			output += check.text;
			if (check.run.error)
				return { exitCode: null, output, error: check.run.error.message };
			// leanchecker exits 0 on some failures, so its output decides too.
			if (check.run.status !== 0 || /problem|exception|error/i.test(check.text))
				return { exitCode: check.run.status || 1, output, stage: "proof" };
		}
	return { ok: true, output, order };
}

function audit(
	tools: Tools,
	script: string,
	dir: string,
	module: string,
	laws: readonly string[],
	order: string[],
) {
	return spawn(tools, path.dirname(script), tools.lean, [
		"--run",
		script,
		dir,
		module,
		laws.join(","),
		order.join(","),
	]);
}

// The audit's output for each law: the lines after its "law <name>" line.
function sections(stdout: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	let current: string[] | null = null;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("law ")) {
			current = [];
			out.set(line.slice("law ".length), current);
		} else current?.push(line);
	}
	return out;
}

export interface LeanProofJob {
	cwd: string;
	baseLaws: string;
	baseSources: Record<string, string>;
	laws: readonly string[];
}

// Proves the PR's kernel against the base branch's Laws.lean. The verdict
// comes from leanchecker and Touchwarden's audit program: each Proofs.<law>
// must have exactly the type Laws.<law>, use only the standard axioms, and the
// law must mean the same in the PR as on base (a PR cannot, say, add an
// instance that redefines `≤` under an unchanged statement).
function proveLean(job: LeanProofJob, tmp: string): KernelRun {
	const { cwd, baseLaws, baseSources, laws } = job;
	if (!laws.length || !laws.every((law) => NAME.test(law)))
		return {
			exitCode: 1,
			output: "No valid law names to prove.",
			stage: "proof",
		};
	const tools = toolchain();
	if (typeof tools === "string")
		return { exitCode: null, output: "", error: tools };
	const script = path.join(tmp, "audit", "Audit.lean");
	mkdirSync(path.dirname(script), { recursive: true });
	writeFileSync(script, AUDIT);

	const pr = path.join(tmp, "pr");
	stageSources(cwd, pr, ".lean");
	writeFileSync(path.join(pr, "Laws.lean"), baseLaws);
	const built = build(tools, pr, "Proof", true);
	if (!("ok" in built)) return built;
	let output = built.output;
	const checked = audit(tools, script, pr, "Proof", laws, built.order);
	// The audit's stdout is the fingerprint: compared below, too long to report.
	output += checked.run.stderr || "";
	if (checked.run.error)
		return { exitCode: null, output, error: checked.run.error.message };
	if (checked.run.status !== 0)
		return { exitCode: checked.run.status || 1, output, stage: "proof" };
	const proved = sections(checked.run.stdout);
	for (const law of laws) {
		const lines = proved.get(law) ?? [];
		if (!lines.includes("proof-type true"))
			return {
				exitCode: 1,
				output: `${output}\nProofs.${law} is missing or does not have exactly the type Laws.${law}.`,
				stage: "proof",
			};
		const axioms = lines.find((line) => line.startsWith("axioms "));
		const extra = (axioms?.slice("axioms ".length) ?? "")
			.split(",")
			.filter((axiom) => axiom && !ALLOWED_AXIOMS.has(axiom));
		if (!axioms || extra.length)
			return {
				exitCode: 1,
				output: `${output}\nProofs.${law} relies on non-standard axioms: ${extra.join(", ")}.`,
				stage: "proof",
			};
	}

	const base = path.join(tmp, "base");
	for (const [file, text] of Object.entries(baseSources)) {
		mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
		writeFileSync(path.join(base, file), text);
	}
	writeFileSync(path.join(base, "Laws.lean"), baseLaws);
	const baseBuilt = build(tools, base, "Laws", false);
	if (!("ok" in baseBuilt))
		return {
			...baseBuilt,
			output: `${output}\nThe laws on the base branch do not build:\n${baseBuilt.output}`,
		};
	const baseAudit = audit(tools, script, base, "Laws", laws, baseBuilt.order);
	if (baseAudit.run.error)
		return { exitCode: null, output, error: baseAudit.run.error.message };
	const based = sections(baseAudit.run.stdout);
	// Everything after the "meaning" line; empty when the audit never got there.
	const meaning = (lines: readonly string[]) => {
		const start = lines.indexOf("meaning");
		return start === -1 ? [] : lines.slice(start + 1);
	};
	for (const law of laws) {
		const prMeaning = meaning(proved.get(law) ?? []);
		const baseMeaning = meaning(based.get(law) ?? []);
		if (
			baseAudit.run.status !== 0 ||
			prMeaning.length === 0 ||
			prMeaning.join("\n") !== baseMeaning.join("\n")
		) {
			const differs =
				prMeaning.find((line, i) => line !== baseMeaning[i]) ?? "";
			const name =
				/^(?:const|value|inductive|missing|opaque|axiom) ([^\s:]+)/.exec(
					differs,
				)?.[1];
			return {
				exitCode: 1,
				output: `${output}\nLaws.${law} no longer means what it does on the base branch${name ? `: ${name} differs` : ""}. A law's statement, and the types, instances and constants it relies on, must match base; only kernel function bodies may change.`,
				stage: "proof",
			};
		}
	}
	return { exitCode: 0, output, stage: "proof" };
}

/** Proves `laws` in a Lean kernel directory, in a scratch copy. */
export function proveLeanLaws(job: LeanProofJob): KernelRun {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "prove-lean-"));
	try {
		return proveLean(job, tmp);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

const leanJob = (job: KernelJob): LeanProofJob => ({
	cwd: job.cwd,
	baseLaws: job.baseLaws,
	baseSources: job.baseSources,
	laws: [job.law],
});

function runLean(job: KernelJob): KernelRun {
	return proveLeanLaws(leanJob(job));
}

// Proves as plain Lean, then rebuilds Main.lean with Lasm's release profile,
// which is byte-reproducible, and requires the app's program.wasm to match.
function runLasm(job: KernelJob): KernelRun {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "prove-lasm-"));
	try {
		const proof = proveLean(leanJob(job), path.join(tmp, "proof"));
		if (proof.exitCode !== 0 || job.generated === null) return proof;
		const build = path.join(tmp, "build");
		stageSources(job.cwd, build, ".lean");
		rmSync(path.join(build, "lakefile.lean"), { force: true });
		writeFileSync(path.join(build, "Laws.lean"), job.baseLaws);
		if (!existsSync(path.join(build, "Main.lean")))
			return {
				exitCode: 1,
				output: `${proof.output}\nThe kernel has no Main.lean for Lasm to build.`,
				stage: "compiled",
			};
		const [cmd, args] = lasmCommand();
		const emit = spawnSync(
			cmd,
			[...args, "build", "Main.lean", "--output", "dist"],
			{
				cwd: build,
				encoding: "utf8",
				timeout: 600_000,
				maxBuffer: 4_000_000,
				// Lasm needs HOME for its toolchain cache; nothing else is passed on.
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					HOME: process.env.HOME ?? build,
					...(process.env.LASM_TOOLCHAIN_CACHE
						? { LASM_TOOLCHAIN_CACHE: process.env.LASM_TOOLCHAIN_CACHE }
						: {}),
					DO_NOT_TRACK: "1",
				},
			},
		);
		const output = `${proof.output}${emit.stdout || ""}${emit.stderr || ""}`;
		if (emit.error)
			return { exitCode: null, output, error: emit.error.message };
		const wasm = path.join(build, "dist", "program.wasm");
		if (emit.status !== 0 || !existsSync(wasm))
			return { exitCode: 1, output, stage: "compiled" };
		if (!readFileSync(wasm).equals(job.generated))
			return {
				exitCode: 1,
				output: `${output}\nThe program.wasm the app runs does not match a fresh Lasm release build of the proven source.`,
				stage: "compiled",
			};
		return { exitCode: 0, output };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

function bindLean(law: string, proofText: string, baseLaws: string) {
	const name = law.replace(/^Laws\./, "");
	if (
		!NAME.test(name) ||
		!new RegExp(`\\bdef\\s+(?:Laws\\.)?${name}\\s*:\\s*Prop\\b`).test(
			baseLaws,
		) ||
		!new RegExp(`\\btheorem\\s+(?:Proofs\\.)?${name}\\b`).test(proofText)
	)
		return null;
	return name;
}

const leanBase = {
	lawsFile: "Laws.lean",
	proofFile: "Proof.lean",
	sourceExtension: ".lean",
	executesRepoCode: true,
	bind: bindLean,
} as const;

export const lean: ProofBackend = {
	...leanBase,
	id: "lean",
	name: "Lean",
	adapterFiles: [],
	// Nothing the app runs is compiled from these files.
	passLabel: "MODEL PROVEN",
	scope:
		"only the Lean model is verified; the app does not run this code, so whether it behaves like the model is not proven.",
	command() {
		const [cmd, args] = leanCommand();
		return `${[cmd, ...args].join(" ")} Proof.lean + leanchecker + #print axioms`;
	},
	run: runLean,
};

export const lasm: ProofBackend = {
	...leanBase,
	id: "lasm",
	name: "Lean (Lasm)",
	// Main.lean wraps the kernel for the app; Lasm builds it but no law covers it.
	adapterFiles: ["Main.lean"],
	passLabel: "KERNEL PROVEN",
	scope:
		"only the Lean kernel is verified; Main.lean, the Lasm compiler, its runtime and the JavaScript bridge are trusted, not proved.",
	command() {
		const [cmd, args] = lasmCommand();
		const [leanCmd, leanArgs] = leanCommand();
		return `${[leanCmd, ...leanArgs].join(" ")} Proof.lean + leanchecker + #print axioms; ${[cmd, ...args].join(" ")} build Main.lean`;
	},
	run: runLasm,
};
