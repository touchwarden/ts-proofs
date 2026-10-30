import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	backends,
	bend,
	lasm,
	lasmCommand,
	lean,
	leanCommand,
} from "../src/index.ts";

const available = (command: [string, string[]]) =>
	!spawnSync(command[0], [...command[1], "--version"], { encoding: "utf8" })
		.error;
const noLean = available(leanCommand())
	? false
	: "Lean is not installed (set PROVE_LEAN or put lean on PATH)";
const noLasm =
	noLean ||
	(available(lasmCommand())
		? false
		: "Lasm is not installed (set PROVE_LASM or put lasm on PATH)");

const KERNEL = `namespace Kernel
def allowed (captured refunded amount : Nat) : Bool :=
  refunded + amount ≤ captured && amount > 0
end Kernel
`;
const LAWS = `import Kernel
namespace Laws
def never_exceeds : Prop := ∀ c r a, Kernel.allowed c r a = true → r + a ≤ c
def zero_rejected : Prop := ∀ c r, Kernel.allowed c r 0 = false
end Laws
`;
const PROOF = `import Laws
namespace Proofs
theorem never_exceeds : Laws.never_exceeds := by
  intro c r a h
  simp [Kernel.allowed] at h
  exact h.1
theorem zero_rejected : Laws.zero_rejected := by
  intro c r
  simp [Kernel.allowed]
end Proofs
`;
const MAIN = `import Kernel
def main (args : List String) : IO Unit :=
  match args.map String.toNat! with
  | [c, r, a] => IO.println (if Kernel.allowed c r a then "allow" else "reject")
  | _ => IO.println "usage: captured refunded amount"
`;

const BASE = {
	"Kernel.lean": KERNEL,
	"Laws.lean": LAWS,
	"Proof.lean": PROOF,
	"Main.lean": MAIN,
};

function kernel(files: Record<string, string> = {}) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "touchwarden-lean-test-"));
	const all = {
		"Kernel.lean": KERNEL,
		"Laws.lean": LAWS,
		"Proof.lean": PROOF,
		"Main.lean": MAIN,
		...files,
	};
	for (const [name, text] of Object.entries(all)) {
		mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
		writeFileSync(path.join(dir, name), text);
	}
	return dir;
}

function prove(law: string, files: Record<string, string> = {}) {
	const dir = kernel(files);
	try {
		return lean.run({
			cwd: dir,
			baseLaws: LAWS,
			baseSources: BASE,
			law,
			generated: null,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("every backend names distinct laws and proof files", () => {
	assert.deepEqual(Object.keys(backends), ["bend", "lean", "lasm"]);
	assert.equal(lean.passLabel, "MODEL PROVEN");
	assert.equal(lasm.passLabel, "KERNEL PROVEN");
	assert.ok(lean.executesRepoCode && lasm.executesRepoCode);
	assert.equal(bend.executesRepoCode, false);
	assert.deepEqual(lasm.adapterFiles, ["Main.lean"]);
});

test("Lean binds only laws that are Props on base and proved in Proofs", () => {
	assert.equal(lean.bind("Laws.never_exceeds", PROOF, LAWS), "never_exceeds");
	assert.equal(lean.bind("Laws.missing", PROOF, LAWS), null);
	assert.equal(lean.bind("Laws.never_exceeds", "", LAWS), null);
	assert.equal(lean.bind("Laws.x) || true", PROOF, LAWS), null);
});

test("Bend binding is unchanged", () => {
	const laws = "law balanced:\n  ...\n";
	const proof = "import ./LAWS.bend as Laws\ndef Laws.balanced(x):\n";
	assert.equal(bend.bind("Laws.balanced", proof, laws), "balanced");
	assert.equal(bend.bind("Laws.Balanced", proof, laws), null);
});

test("an honest Lean proof passes", { skip: noLean }, () => {
	const run = prove("never_exceeds");
	assert.equal(run.exitCode, 0, run.output);
});

test("a kernel change that breaks the law fails", { skip: noLean }, () => {
	const run = prove("never_exceeds", {
		"Kernel.lean": KERNEL.replace("refunded + amount ≤ captured", "true"),
	});
	assert.equal(run.exitCode, 1);
	assert.equal(run.stage, "proof");
	assert.match(run.output, /Proof\.lean:\d+:\d+: error/);
});

test("sorry is refused even though Lean only warns", { skip: noLean }, () => {
	const run = prove("zero_rejected", {
		"Proof.lean": PROOF.replace("intro c r\n  simp [Kernel.allowed]", "sorry"),
	});
	assert.equal(run.exitCode, 1);
	assert.match(run.output, /non-standard axioms: sorryAx/);
});

test("native_decide is refused", { skip: noLean }, () => {
	const run = prove("zero_rejected", {
		"Proof.lean": PROOF.replace(
			"intro c r\n  simp [Kernel.allowed]",
			"intro c r\n  have _k : Kernel.allowed 1 0 0 = false := by native_decide\n  simp [Kernel.allowed]",
		),
	});
	assert.equal(run.exitCode, 1, run.output);
	assert.match(run.output, /non-standard axioms: .*native_decide/);
});

test("a PR cannot weaken Laws.lean; base laws are used", {
	skip: noLean,
}, () => {
	const run = prove("never_exceeds", {
		"Kernel.lean": KERNEL.replace("refunded + amount ≤ captured", "true"),
		"Laws.lean": LAWS.replace(
			"Kernel.allowed c r a = true → r + a ≤ c",
			"True",
		),
		"Proof.lean": PROOF.replace(
			"intro c r a h\n  simp [Kernel.allowed] at h\n  exact h.1",
			"trivial",
		),
	});
	assert.equal(run.exitCode, 1);
	assert.match(run.output, /Proof\.lean:\d+:\d+: error/);
});

test("a theorem with the right name but a different statement fails", {
	skip: noLean,
}, () => {
	const run = prove("never_exceeds", {
		"Proof.lean": `import Laws\nnamespace Proofs\ntheorem never_exceeds : True := trivial\nend Proofs\n`,
	});
	assert.equal(run.exitCode, 1);
	assert.match(
		run.output,
		/does not have exactly the type Laws\.never_exceeds/,
	);
});

test("commands that run code or skip the kernel are refused before Lean runs", () => {
	for (const line of [
		"run_cmd pure ()",
		"#eval IO.println 1",
		"set_option debug.skipKernelTC true",
		'@[extern "x"] opaque f : Nat',
		'macro "x" : term => `(1)',
	]) {
		const run = prove("never_exceeds", { "Proof.lean": `${PROOF}${line}\n` });
		assert.equal(run.exitCode, 1, line);
		assert.match(run.output, /may not use/, line);
	}
});

test("imports outside the kernel, Init and Std are refused", () => {
	const run = prove("never_exceeds", { "Proof.lean": `import Lean\n${PROOF}` });
	assert.equal(run.exitCode, 1);
	assert.match(run.output, /only local modules, Init and Std/);
});

test("a lakefile is never built or run", { skip: noLean }, () => {
	const run = prove("never_exceeds", {
		"lakefile.lean": "import Lake\n#eval IO.Process.exit 9\n",
	});
	assert.equal(run.exitCode, 0, run.output);
});

const HIJACK = `@[command_elab Lean.Parser.Command.printAxioms] def fake : Lean.Elab.Command.CommandElab := fun _ => Lean.logInfo "'Proofs.zero_rejected' does not depend on any axioms"
namespace Proofs
theorem zero_rejected : Laws.zero_rejected := sorry
end Proofs
`;

test("imports must be alone on their line", () => {
	for (const header of [
		"import Laws\nimport Lean -- x",
		"import Laws Lean",
		"import Laws\npublic import Lean",
	]) {
		const run = prove("zero_rejected", {
			"Proof.lean": `${header}\n${HIJACK}`,
		});
		assert.equal(run.exitCode, 1, header);
		assert.doesNotMatch(run.output, /^'Proofs/m, header);
	}
});

test("a local module cannot pose as Std, Init or Lean", () => {
	const run = prove("zero_rejected", {
		"Std/Evil.lean": "def x := 1\n",
		"Proof.lean": `import Laws\nimport Std.Evil\n${PROOF.replace("import Laws\n", "")}`,
	});
	assert.equal(run.exitCode, 1);
	assert.match(run.output, /reserved for the Lean toolchain/);
});

test("sorry fails even when nothing can fake the axiom report", {
	skip: noLean,
}, () => {
	// Std has no elaborator API, so the fake does not build; either way, no pass.
	const run = prove("zero_rejected", {
		"Proof.lean": `import Laws\nimport Std\n${HIJACK.replace("@[command_elab Lean.Parser.Command.printAxioms] ", "")}`,
	});
	assert.equal(run.exitCode, 1);
});

test("an instance that redefines ≤ under an unchanged law fails", {
	skip: noLean,
}, () => {
	const run = prove("never_exceeds", {
		"Kernel.lean": `instance (priority := high) evil : LE Nat := ⟨fun _ _ => True⟩\n${KERNEL.replace("refunded + amount ≤ captured && amount > 0", "true")}`,
		"Proof.lean":
			"import Laws\nnamespace Proofs\ntheorem never_exceeds : Laws.never_exceeds := fun _ _ _ _ => trivial\nend Proofs\n",
	});
	assert.equal(run.exitCode, 1, run.output);
	assert.match(run.output, /no longer means what it does on the base branch/);
});

test("narrowing the kernel's argument types under an unchanged law fails", {
	skip: noLean,
}, () => {
	const run = prove("never_exceeds", {
		"Kernel.lean":
			"namespace Kernel\ndef allowed (captured refunded amount : Fin 1) : Bool := true\nend Kernel\n",
		"Proof.lean":
			"import Laws\nnamespace Proofs\ntheorem never_exceeds : Laws.never_exceeds := by\n  intro c r a _\n  omega\nend Proofs\n",
	});
	assert.equal(run.exitCode, 1, run.output);
});

test("Lasm: program.wasm must be a fresh release build of the proven source", {
	skip: noLasm,
	timeout: 600_000,
}, () => {
	const dir = kernel();
	try {
		// Build once as the app would, from a different directory.
		const app = mkdtempSync(path.join(os.tmpdir(), "touchwarden-lasm-app-"));
		cpSync(dir, app, { recursive: true });
		const [cmd, args] = lasmCommand();
		const built = spawnSync(cmd, [...args, "build", "Main.lean"], {
			cwd: app,
			encoding: "utf8",
		});
		assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);
		const wasm = readFileSync(path.join(app, "dist", "program.wasm"));
		rmSync(app, { recursive: true, force: true });
		const fresh = lasm.run({
			cwd: dir,
			baseLaws: LAWS,
			baseSources: BASE,
			law: "never_exceeds",
			generated: wasm,
		});
		assert.equal(fresh.exitCode, 0, fresh.output);
		const stale = Buffer.from(wasm);
		stale[stale.length - 1] = (stale.at(-1) ?? 0) ^ 1;
		const tampered = lasm.run({
			cwd: dir,
			baseLaws: LAWS,
			baseSources: BASE,
			law: "never_exceeds",
			generated: stale,
		});
		assert.equal(tampered.exitCode, 1);
		assert.equal(tampered.stage, "compiled");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
