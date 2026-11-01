// Turns a proven Lean kernel directory (Kernel.lean and friends, Laws.lean,
// Proof.lean) into files an app imports. Like the Bend generator, it refuses
// to generate unless every law in Laws.lean is proved, and it reads the
// kernel's types from the compiled Lean environment rather than from the
// source text, so what it generates matches what Lean checked.
//
// lasm (Lean compiled to wasm, the app runs the proven code):
//   Main.lean         publishes the entry function to JavaScript
//   dist/             Lasm's release build of Main.lean (written by `prove generate`)
//   <name>.gen.ts     app types, input and output checks, an async decider
//   <name>.meta.json  Lean version, laws, hashes
//
// lean (a proven model; the app runs its own TypeScript):
//   Oracle.lean       answers the entry function over JSON lines, for tests
//   <name>.gen.ts     app types, input checks, `implement…` to wrap your own
//                     implementation as a decider, and `check…AgainstModel`
//                     to compare it with the proven model
//   <name>.meta.json

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
	build,
	lasmCommand,
	proveLeanLaws,
	spawn,
	toolchain,
} from "../backends/lean.ts";
import {
	type GeneratedKernel,
	KernelBuildError,
	list,
	moduleName,
	q,
	reachable,
	tsType,
	typeDeclaration,
} from "./bend.ts";
import type { DataType, FieldType } from "./bend-source.ts";

export interface LeanRuntime {
	readonly core: string;
	readonly lasm: string;
	readonly model: string;
}

export const PACKAGE_RUNTIME: LeanRuntime = {
	core: "@touchwarden/ts-proofs/runtime",
	lasm: "@touchwarden/ts-proofs/lasm",
	model: "@touchwarden/ts-proofs/model",
};

export interface LeanGenerateOptions {
	/** The kernel directory; its name becomes the module name. */
	readonly dir: string;
	/** The deciding function's full Lean name, e.g. "Kernel.decide". */
	readonly entry: string;
	readonly backend: "lean" | "lasm";
	readonly runtime?: LeanRuntime;
	/** Name of the exported approval type; defaults to <Name>Approved. */
	readonly proofType?: string;
}

interface LeanKernel {
	/** Short TypeScript name to type. */
	readonly types: ReadonlyMap<string, DataType>;
	/** Short TypeScript name to full Lean name. */
	readonly leanNames: ReadonlyMap<string, string>;
	readonly entry: {
		readonly name: string;
		readonly leanName: string;
		readonly module: string;
		readonly param: FieldType;
		readonly refusal: FieldType;
		readonly value: FieldType;
	};
}

const sha256 = (data: string | Buffer) =>
	createHash("sha256").update(data).digest("hex");

// Generated TypeScript uses these names itself.
const RESERVED = new Set(["tw", "kernel", "i", "o", "model", "lasmKernel"]);

// Run with `lean --run`. Loads the compiled kernel without running its code
// and prints the entry's signature and every type it reaches, as JSON.
const DESCRIBE = `import Lean
open Lean

structure S where
  types : Array Json := #[]
  seen : NameSet := {}

abbrev M := StateT S (ExceptT String IO)

def kind (k : String) : Json := Json.mkObj [("kind", k)]

mutual
partial def fieldType (env : Environment) (e : Expr) : M Json := do
  match e.consumeMData with
  | .const \`\`Nat [] => return kind "Nat"
  | .const \`\`Bool [] => return kind "Bool"
  | .const \`\`String [] => return kind "String"
  | .app (.const \`\`List _) a => return Json.mkObj [("kind", "List"), ("item", ← fieldType env a)]
  | .app (.const \`\`Option _) a => return Json.mkObj [("kind", "Maybe"), ("item", ← fieldType env a)]
  | .const n [] => do
    dataType env n
    return Json.mkObj [("kind", "Data"), ("name", n.toString)]
  | other => throw s!"unsupported type {other}: use Nat, Bool, String, List, Option, or a structure or enumeration of them"

partial def dataType (env : Environment) (n : Name) : M Unit := do
  if (← get).seen.contains n then return
  modify fun s => { s with seen := s.seen.insert n }
  let some (.inductInfo i) := env.find? n | throw s!"{n} is not a structure or enumeration"
  if i.numParams != 0 || i.numIndices != 0 || i.isRec then
    throw s!"{n} has parameters, indices or recursion; use a plain structure or enumeration"
  let mut ctors : Array Json := #[]
  for c in i.ctors do
    let some info := env.find? c | throw s!"{c} not found"
    let mut fields : Array Json := #[]
    let mut t := info.type
    while true do
      match t with
      | .forallE x ty body _ =>
        if body.hasLooseBVars then throw s!"{c} has a dependent field {x}"
        fields := fields.push (Json.mkObj [("name", x.toString), ("type", ← fieldType env ty)])
        t := body
      | _ => break
    ctors := ctors.push (Json.mkObj [("name", c.getString!), ("fields", Json.arr fields)])
  let enum := i.ctors.all fun c => match env.find? c with
    | some (.ctorInfo ci) => ci.numFields == 0
    | _ => false
  let shape := if isStructure env n then "record" else if enum then "enum" else "union"
  if shape == "union" then throw s!"{n} has constructors with fields; use a structure or an enumeration"
  modify fun s => { s with types := s.types.push (Json.mkObj [("name", n.toString), ("shape", shape), ("constructors", Json.arr ctors)]) }
end

def main (args : List String) : IO UInt32 := do
  let [dir, module, entry] := args | return 2
  initSearchPath (← findSysroot) [dir]
  let env ← importModules #[{ module := module.toName }] {} (trustLevel := 0)
  let entryName := entry.toName
  let some info := env.find? entryName | do IO.eprintln s!"{entry} was not found"; return 1
  let .forallE _ param (.app (.app (.const \`\`Except _) err) val) _ := info.type.consumeMData
    | do IO.eprintln s!"{entry} must take one argument and return Except: A → Except E V"; return 1
  let run : M Json := do
    let p ← fieldType env param
    let e ← fieldType env err
    let v ← fieldType env val
    let some idx := env.getModuleIdxFor? entryName | throw s!"{entry} has no module"
    return Json.mkObj [
      ("entry", Json.mkObj [("module", (env.header.moduleNames[idx.toNat]!).toString), ("param", p), ("refusal", e), ("value", v)]),
      ("types", Json.arr (← get).types)]
  match ← (run.run' {}).run with
  | .ok j => IO.println j.compress; return 0
  | .error msg => IO.eprintln msg; return 1
`;

// Narrowing the describe program's JSON: it is ours, but it is still checked.
const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
function field(v: unknown, key: string): unknown {
	if (!isObject(v))
		throw new KernelBuildError(`describe: expected an object for ${key}`);
	return v[key];
}
function text(v: unknown, key: string): string {
	const value = field(v, key);
	if (typeof value !== "string")
		throw new KernelBuildError(`describe: expected ${key} to be a string`);
	return value;
}
function items(v: unknown, key: string): unknown[] {
	const value = field(v, key);
	if (!Array.isArray(value))
		throw new KernelBuildError(`describe: expected ${key} to be a list`);
	return value;
}

const shortName = (leanName: string) => leanName.split(".").at(-1) ?? leanName;

function readKernel(json: unknown, entry: string): LeanKernel {
	const leanNames = new Map<string, string>();
	const toType = (v: unknown): FieldType => {
		const kind = text(v, "kind");
		if (kind === "Nat" || kind === "Bool" || kind === "String") return { kind };
		if (kind === "List" || kind === "Maybe")
			return { kind, item: toType(field(v, "item")) };
		if (kind === "Data") {
			const name = shortName(text(v, "name"));
			return { kind: "Data", name, args: [] };
		}
		throw new KernelBuildError(`describe: unknown kind ${kind}`);
	};
	const types = new Map<string, DataType>();
	for (const t of items(json, "types")) {
		const leanName = text(t, "name");
		const name = shortName(leanName);
		if (!/^[A-Z][A-Za-z0-9]*$/.test(name) || RESERVED.has(name))
			throw new KernelBuildError(
				`${leanName}: type names must start with a capital letter and avoid ${[...RESERVED].join(", ")}`,
			);
		const clash = leanNames.get(name);
		if (clash && clash !== leanName)
			throw new KernelBuildError(
				`${clash} and ${leanName} would both be ${name} in TypeScript; rename one`,
			);
		leanNames.set(name, leanName);
		const shape = text(t, "shape");
		if (shape !== "record" && shape !== "enum")
			throw new KernelBuildError(`${leanName}: unsupported shape ${shape}`);
		types.set(name, {
			name,
			params: [],
			shape,
			constructors: items(t, "constructors").map((c) => ({
				name: text(c, "name"),
				fields: items(c, "fields").map((f) => ({
					name: text(f, "name"),
					type: toType(field(f, "type")),
				})),
			})),
		});
	}
	const e = field(json, "entry");
	return {
		types,
		leanNames,
		entry: {
			name: shortName(entry),
			leanName: entry,
			module: text(e, "module"),
			param: toType(field(e, "param")),
			refusal: toType(field(e, "refusal")),
			value: toType(field(e, "value")),
		},
	};
}

/** Law names in a Laws.lean: each `def <name> : Prop`. */
export function leanLaws(lawsText: string): string[] {
	return [
		...lawsText.matchAll(
			/^\s*def\s+(?:Laws\.)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*Prop\b/gm,
		),
	].map((m) => m[1] ?? "");
}

/** The kernel's .lean sources except the files this generator writes. */
function kernelSources(dir: string, sub = ""): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of readdirSync(path.join(dir, sub), {
		withFileTypes: true,
	})) {
		const rel = path.posix.join(sub, entry.name);
		if (
			entry.isDirectory() &&
			entry.name !== "dist" &&
			!entry.name.startsWith(".")
		)
			Object.assign(out, kernelSources(dir, rel));
		else if (
			entry.isFile() &&
			entry.name.endsWith(".lean") &&
			!["Main.lean", "Oracle.lean", "lakefile.lean"].includes(rel)
		)
			out[rel] = readFileSync(path.join(dir, rel), "utf8");
	}
	return out;
}

function describe(dir: string, entry: string): LeanKernel {
	const tools = toolchain();
	if (typeof tools === "string") throw new KernelBuildError(tools);
	const work = mkdtempSync(path.join(os.tmpdir(), "prove-describe-"));
	try {
		const src = path.join(work, "src");
		for (const [file, body] of Object.entries(kernelSources(dir))) {
			mkdirSync(path.dirname(path.join(src, file)), { recursive: true });
			writeFileSync(path.join(src, file), body);
		}
		const built = build(tools, src, "Proof", false);
		if (!("ok" in built))
			throw new KernelBuildError(`the kernel does not build:\n${built.output}`);
		const script = path.join(work, "describe", "Describe.lean");
		mkdirSync(path.dirname(script), { recursive: true });
		writeFileSync(script, DESCRIBE);
		const run = spawn(tools, path.dirname(script), tools.lean, [
			"--run",
			script,
			src,
			"Proof",
			entry,
		]);
		if (run.run.status !== 0)
			throw new KernelBuildError(
				`could not read ${entry}'s types:\n${run.text}`,
			);
		return readKernel(JSON.parse(run.run.stdout), entry);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

// Code emission
// =============
// Lean's JSON (Lasm's ToJS, or Lean's ToJson in the oracle) already has the
// app's shape: records are objects, enumerations are constructor names,
// Option is the value or null. So one check function per type serves both
// directions, with the input codec on the way in and the output codec on
// the way back.

const fieldAt = (name: string) => `\`\${at}.${name}\``;

function checkExpr(
	t: FieldType,
	c: "i" | "o",
	value: string,
	at: string,
): string {
	const fn = c === "i" ? "parse" : "check";
	switch (t.kind) {
		case "List":
			return `${c}.list(${value}, ${at}, (x, at) => ${checkExpr(t.item, c, "x", "at")})`;
		case "Maybe":
			return `${c}.maybe(${value}, ${at}, (x, at) => ${checkExpr(t.item, c, "x", "at")})`;
		case "Data":
			return `${fn}${t.name}(${value}, ${at})`;
		case "Param":
			throw new KernelBuildError("type parameters are not supported");
		default:
			return `${c}.${t.kind.toLowerCase()}(${value}, ${at})`;
	}
}

function checkFunction(t: DataType, c: "i" | "o"): string {
	const fn = c === "i" ? "parse" : "check";
	const head = `function ${fn}${t.name}(v: unknown, at: string): ${t.name} {`;
	if (t.shape === "enum")
		return `${head}\n\treturn ${c}.oneOf(v, at, ${list(t.constructors.map((k) => k.name))});\n}`;
	const fields = t.constructors[0]?.fields ?? [];
	return [
		head,
		`\tconst r = ${c}.record(v, at, ${list(fields.map((f) => f.name))});`,
		"\treturn {",
		...fields.map(
			(f) =>
				`\t\t${f.name}: ${checkExpr(f.type, c, `r.${f.name}`, fieldAt(f.name))},`,
		),
		"\t};",
		"}",
	].join("\n");
}

// Random inputs for the model check, built from the same types.
function arbitraryExpr(t: FieldType): string {
	switch (t.kind) {
		case "List":
			return `model.arbitrary.list(r, () => ${arbitraryExpr(t.item)})`;
		case "Maybe":
			return `model.arbitrary.maybe(r, () => ${arbitraryExpr(t.item)})`;
		case "Data":
			return `arbitrary${t.name}(r)`;
		case "Param":
			throw new KernelBuildError("type parameters are not supported");
		default:
			return `model.arbitrary.${t.kind.toLowerCase()}(r)`;
	}
}

function arbitraryFunction(t: DataType): string {
	const head = `function arbitrary${t.name}(r: () => number): ${t.name} {`;
	if (t.shape === "enum")
		return `${head}\n\treturn model.arbitrary.oneOf(r, ${list(t.constructors.map((k) => k.name))});\n}`;
	const fields = t.constructors[0]?.fields ?? [];
	return [
		head,
		"\treturn {",
		...fields.map((f) => `\t\t${f.name}: ${arbitraryExpr(f.type)},`),
		"\t};",
		"}",
	].join("\n");
}

const pascal = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

interface Meta {
	readonly backend: "lean" | "lasm";
	readonly lean: string;
	readonly laws: readonly string[];
	readonly rule: string;
}

function header(
	k: LeanKernel,
	name: string,
	meta: Meta,
	extra: string[],
): string[] {
	const e = k.entry;
	return [
		`// GENERATED by @touchwarden/ts-proofs from ${name}/ (${meta.backend === "lasm" ? "Lean compiled to wasm by Lasm" : "a Lean model"}). Do not edit:`,
		"// change the Lean sources and run `prove generate` again.",
		`// Lean ${meta.lean}${extra.length ? ` | ${extra.join(" | ")}` : ""}`,
		`// Laws (proved, re-checked by leanchecker): ${meta.laws.join(", ")}`,
		`// Entry: ${e.leanName} : ${leanTypeName(k, e.param)} → Except ${leanTypeName(k, e.refusal)} ${leanTypeName(k, e.value)}. .ok approves, .error refuses.`,
	];
}

function leanTypeName(k: LeanKernel, t: FieldType): string {
	switch (t.kind) {
		case "List":
			return `(List ${leanTypeName(k, t.item)})`;
		case "Maybe":
			return `(Option ${leanTypeName(k, t.item)})`;
		case "Data":
			return k.leanNames.get(t.name) ?? t.name;
		case "Param":
			return t.name;
		default:
			return t.kind;
	}
}

function typesSection(k: LeanKernel, withArbitrary: boolean): string[] {
	const e = k.entry;
	const all = reachable({ types: k.types, entry: kernelEntry(k) }, [
		e.param,
		e.refusal,
		e.value,
	]);
	const inputs = reachable({ types: k.types, entry: kernelEntry(k) }, [
		e.param,
	]);
	const outputs = reachable({ types: k.types, entry: kernelEntry(k) }, [
		e.refusal,
		e.value,
	]);
	return [
		...all.map(typeDeclaration).flatMap((d) => [d, ""]),
		...inputs.flatMap((t) => [checkFunction(t, "i"), ""]),
		...outputs.flatMap((t) => [checkFunction(t, "o"), ""]),
		...(withArbitrary ? inputs.flatMap((t) => [arbitraryFunction(t), ""]) : []),
	];
}

// reachable() wants a Bend-shaped KernelSource; only `types` is read.
function kernelEntry(k: LeanKernel) {
	return {
		name: k.entry.name,
		param: { name: "input", type: k.entry.param },
		quantities: ["", ""] as const,
		refusal: k.entry.refusal,
		value: k.entry.value,
	};
}

function answerSection(k: LeanKernel): string[] {
	const e = k.entry;
	const value = tsType(e.value);
	const refusal = tsType(e.refusal);
	return [
		"// The kernel's answer: { done: true, value } approves, { done: false, error } refuses.",
		`function checkAnswer(out: unknown): tw.Outcome<${value}, ${refusal}> {`,
		'\tconst done = o.record(out, "result", ["done", Reflect.get(Object(out), "done") === true ? "value" : "error"]);',
		"\tif (done.done === true)",
		`\t\treturn { done: true, value: ${checkExpr(e.value, "o", "done.value", '"result.value"')} };`,
		"\tif (done.done === false)",
		`\t\treturn { done: false, error: ${checkExpr(e.refusal, "o", "done.error", '"result.error"')} };`,
		'\treturn o.fail("result.done", "expected true or false");',
		"}",
		"",
	];
}

function lasmModule(
	k: LeanKernel,
	name: string,
	runtime: LeanRuntime,
	proofType: string,
	meta: Meta & { wasm: string },
): string {
	const e = k.entry;
	const input = tsType(e.param);
	return [
		...header(k, name, meta, [`dist/program.wasm sha256 ${meta.wasm}`]),
		`import * as tw from ${q(runtime.core)};`,
		`import { lasmKernel } from ${q(runtime.lasm)};`,
		"",
		"const i = tw.inputCodec;",
		"const o = tw.outputCodec;",
		"",
		...typesSection(k, false),
		...answerSection(k),
		`const parseInput = (v: unknown, at: string): ${input} => ${checkExpr(e.param, "i", "v", "at")};`,
		"",
		`/** Standard Schema for ${e.name}'s input: the same check the decider runs. */`,
		`export const ${e.name}Input: tw.StandardSchemaV1<${input}> = tw.standardSchema(parseInput);`,
		"",
		"// Started on first use; the program then stays up and answers each call.",
		'const kernel = () => lasmKernel(new URL("./dist/main.mjs", import.meta.url));',
		"",
		`export const ${name} = {`,
		`\t${e.name}: tw.defineAsyncDecider(${q(meta.rule)}, parseInput, async (input: ${input}) =>`,
		"\t\tcheckAnswer(await (await kernel())(input)),",
		"\t),",
		"};",
		"",
		`/** Proof that the proven kernel approved: require it where the decision is acted on. */`,
		`export type ${proofType} = tw.Approved<typeof ${name}.${e.name}>;`,
		"",
	].join("\n");
}

function modelModule(
	k: LeanKernel,
	name: string,
	runtime: LeanRuntime,
	proofType: string,
	meta: Meta,
): string {
	const e = k.entry;
	const input = tsType(e.param);
	const value = tsType(e.value);
	const refusal = tsType(e.refusal);
	const Name = pascal(name);
	return [
		...header(k, name, meta, [
			"model only: the app runs its own implementation",
		]),
		`import * as tw from ${q(runtime.core)};`,
		`import * as model from ${q(runtime.model)};`,
		"",
		"const i = tw.inputCodec;",
		"const o = tw.outputCodec;",
		"",
		...typesSection(k, true),
		...answerSection(k),
		`const parseInput = (v: unknown, at: string): ${input} => ${checkExpr(e.param, "i", "v", "at")};`,
		"",
		`/** Standard Schema for ${e.name}'s input. */`,
		`export const ${e.name}Input: tw.StandardSchemaV1<${input}> = tw.standardSchema(parseInput);`,
		"",
		`/** Your TypeScript version of ${e.leanName}. */`,
		`export type ${Name}Implementation = (input: ${input}) => tw.Outcome<${value}, ${refusal}>;`,
		"",
		"/**",
		` * Wraps your implementation as the decider that issues ${proofType}.`,
		" * Call it once, in the file your gate lists as trusted, and keep",
		` * check${Name}AgainstModel passing in your tests: approvals come from code`,
		" * that is tested against the proven model, not proven itself.",
		" */",
		`export function implement${Name}(implementation: ${Name}Implementation) {`,
		`\treturn tw.defineDecider(${q(meta.rule)}, parseInput, implementation);`,
		"}",
		"",
		`/** Proof that your ${e.name} approved: require it where the decision is acted on. */`,
		`export type ${proofType} = tw.Approval<${q(meta.rule)}, ${input}, ${value}>;`,
		"",
		`/** Runs your implementation and the proven Lean model on the same inputs and lists every disagreement. */`,
		`export function check${Name}AgainstModel(`,
		`\timplementation: ${Name}Implementation,`,
		`\toptions: model.CompareOptions<${input}> = {},`,
		`): model.Mismatch<${input}>[] {`,
		"\treturn model.compareWithModel(",
		"\t\t{",
		'\t\t\tkernelDir: new URL(".", import.meta.url),',
		`\t\t\tmodule: ${q(e.module)},`,
		"\t\t\tparse: parseInput,",
		"\t\t\tanswer: checkAnswer,",
		`\t\t\tarbitrary: (r) => ${arbitraryExpr(e.param)},`,
		"\t\t},",
		"\t\timplementation,",
		"\t\toptions,",
		"\t);",
		"}",
		"",
	].join("\n");
}

function inputTypes(k: LeanKernel): DataType[] {
	return reachable({ types: k.types, entry: kernelEntry(k) }, [k.entry.param]);
}
function outputTypes(k: LeanKernel): DataType[] {
	return reachable({ types: k.types, entry: kernelEntry(k) }, [
		k.entry.refusal,
		k.entry.value,
	]);
}
const leanName = (k: LeanKernel, t: DataType) =>
	k.leanNames.get(t.name) ?? t.name;

function mainLean(k: LeanKernel): string {
	const e = k.entry;
	return [
		"-- GENERATED by @touchwarden/ts-proofs. Do not edit: run `prove generate` again.",
		`-- Publishes ${e.leanName} to JavaScript for the generated decider. No law`,
		"-- covers this file; `prove generate --check` catches hand edits.",
		`import ${e.module}`,
		"import Lasm.JS",
		"open Lasm.JS",
		"",
		...inputTypes(k).map(
			(t) => `deriving instance FromJS for ${leanName(k, t)}`,
		),
		...outputTypes(k).map(
			(t) => `deriving instance ToJS for ${leanName(k, t)}`,
		),
		"",
		"def main : IO Unit := do",
		"  let decide ← Function.ofFn fun args => do",
		`    let input ← decodeAs ${leanTypeName(k, e.param)} "input" (args[0]!)`,
		`    return match ${e.leanName} input with`,
		'      | .ok value => obj [("done", toJS true), ("value", toJS value)]',
		'      | .error error => obj [("done", toJS false), ("error", toJS error)]',
		"  exportDefault decide",
		"  waitForever",
		"",
	].join("\n");
}

function oracleLean(k: LeanKernel): string {
	const e = k.entry;
	const all = reachable({ types: k.types, entry: kernelEntry(k) }, [
		e.param,
		e.refusal,
		e.value,
	]);
	return [
		"-- GENERATED by @touchwarden/ts-proofs. Do not edit: run `prove generate` again.",
		`-- Answers ${e.leanName} for each JSON line on stdin, so tests can compare an`,
		"-- implementation with the proven model. Not part of the proof.",
		"import Lean",
		`import ${e.module}`,
		"open Lean",
		"",
		...all.map(
			(t) => `deriving instance FromJson, ToJson for ${leanName(k, t)}`,
		),
		"",
		"def main : IO Unit := do",
		"  let stdin ← IO.getStdin",
		"  let stdout ← IO.getStdout",
		"  repeat",
		"    let line ← stdin.getLine",
		"    if line.isEmpty then break",
		`    let out : Json := match Json.parse line >>= fromJson? (α := ${leanTypeName(k, e.param)}) with`,
		'      | .error msg => Json.mkObj [("invalid", msg)]',
		`      | .ok input => match ${e.leanName} input with`,
		'        | .ok value => Json.mkObj [("done", true), ("value", toJson value)]',
		'        | .error error => Json.mkObj [("done", false), ("error", toJson error)]',
		"    stdout.putStrLn out.compress",
		"    stdout.flush",
		"",
	].join("\n");
}

/** Builds Main.lean with Lasm's release profile into `out`; returns program.wasm. */
export function lasmBuild(sourceDir: string, out: string): Buffer {
	const [cmd, args] = lasmCommand();
	const run = spawnSync(cmd, [...args, "build", "Main.lean", "--output", out], {
		cwd: sourceDir,
		encoding: "utf8",
		timeout: 600_000,
		maxBuffer: 8_000_000,
	});
	if (run.error)
		throw new KernelBuildError(`could not run ${cmd}: ${run.error.message}`);
	const wasm = path.join(out, "program.wasm");
	if (run.status !== 0 || !existsSync(wasm))
		throw new KernelBuildError(
			`Lasm could not build Main.lean:\n${run.stdout}${run.stderr}`,
		);
	return readFileSync(wasm);
}

function leanVersion(): string {
	const tools = toolchain();
	if (typeof tools === "string") throw new KernelBuildError(tools);
	const run = spawnSync(tools.lean, ["--version"], { encoding: "utf8" });
	return /version (\d+\.\d+\.\d+)/.exec(run.stdout)?.[1] ?? "unknown";
}

export interface GeneratedLeanKernel extends GeneratedKernel {
	/** For lasm: program.wasm built from the generated Main.lean. */
	readonly wasm?: Buffer;
}

export function generateLeanKernel(
	options: LeanGenerateOptions,
): GeneratedLeanKernel {
	const dir = path.resolve(options.dir);
	const name = moduleName(dir);
	const runtime = options.runtime ?? PACKAGE_RUNTIME;
	const proofType = options.proofType ?? `${pascal(name)}Approved`;
	for (const file of ["Laws.lean", "Proof.lean"])
		if (!existsSync(path.join(dir, file)))
			throw new KernelBuildError(
				`${dir} has no ${file}; a Lean kernel needs Laws.lean and Proof.lean`,
			);
	const lawsText = readFileSync(path.join(dir, "Laws.lean"), "utf8");
	const laws = leanLaws(lawsText);
	if (!laws.length)
		throw new KernelBuildError(
			"Laws.lean states no laws (def <name> : Prop), so the kernel proves nothing; nothing was generated",
		);
	const sources = kernelSources(dir);
	const proof = proveLeanLaws({
		cwd: dir,
		baseLaws: lawsText,
		baseSources: sources,
		laws,
	});
	if (proof.exitCode !== 0)
		throw new KernelBuildError(
			`Lean did not accept the proofs, so nothing was generated:\n${proof.error ?? proof.output}`,
		);
	const kernel = describe(dir, options.entry);
	const meta: Meta = {
		backend: options.backend,
		lean: leanVersion(),
		laws,
		rule: `${name}.${kernel.entry.name}`,
	};
	const hashes = Object.fromEntries(
		Object.entries(sources).map(([file, body]) => [file, sha256(body)]),
	);
	const files = new Map<string, string>();
	let wasm: Buffer | undefined;
	if (options.backend === "lasm") {
		const main = mainLean(kernel);
		// Build in a scratch copy so nothing lands in the kernel directory
		// unless every step passed.
		const work = mkdtempSync(path.join(os.tmpdir(), "prove-lasm-gen-"));
		try {
			for (const [file, body] of Object.entries(sources)) {
				mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
				writeFileSync(path.join(work, file), body);
			}
			writeFileSync(path.join(work, "Main.lean"), main);
			wasm = lasmBuild(work, path.join(work, "dist"));
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
		const wasmHash = sha256(wasm);
		files.set("Main.lean", main);
		files.set(
			`${name}.gen.ts`,
			lasmModule(kernel, name, runtime, proofType, { ...meta, wasm: wasmHash }),
		);
		files.set(
			`${name}.meta.json`,
			`${JSON.stringify({ generator: "@touchwarden/ts-proofs", ...meta, entry: options.entry, proofType, sources: hashes, wasm: { file: "dist/program.wasm", sha256: wasmHash } }, null, "\t")}\n`,
		);
	} else {
		files.set("Oracle.lean", oracleLean(kernel));
		files.set(
			`${name}.gen.ts`,
			modelModule(kernel, name, runtime, proofType, meta),
		);
		files.set(
			`${name}.meta.json`,
			`${JSON.stringify({ generator: "@touchwarden/ts-proofs", ...meta, entry: options.entry, proofType, sources: hashes }, null, "\t")}\n`,
		);
	}
	return { name, rule: meta.rule, files, ...(wasm ? { wasm } : {}) };
}

/** Writes the generated files, and for lasm the Lasm build into dist/. */
export function writeLeanKernel(
	dir: string,
	generated: GeneratedLeanKernel,
): string[] {
	const written: string[] = [];
	for (const [file, body] of generated.files) {
		writeFileSync(path.join(dir, file), body);
		written.push(file);
	}
	if (generated.wasm) {
		const out = path.join(dir, "dist");
		rmSync(out, { recursive: true, force: true });
		const wasm = lasmBuild(dir, out);
		// Release builds are byte-reproducible; a difference means the toolchain moved.
		if (!wasm.equals(generated.wasm))
			throw new KernelBuildError(
				"Lasm's build in the kernel directory differs from the scratch build; check the Lasm version",
			);
		written.push("dist/");
	}
	return written;
}

/** Generated files on disk that differ from a fresh generation (for CI). */
export function staleLeanFiles(
	dir: string,
	generated: GeneratedLeanKernel,
): string[] {
	const stale = [...generated.files].flatMap(([file, body]) => {
		const target = path.join(dir, file);
		return existsSync(target) && readFileSync(target, "utf8") === body
			? []
			: [file];
	});
	// dist/ is a build output that is often not committed. The .gen.ts header
	// records the wasm's sha256, so the text comparison above already checks
	// a fresh build; a dist/ that is present must match it too.
	const target = path.join(dir, "dist", "program.wasm");
	if (
		generated.wasm &&
		existsSync(target) &&
		!readFileSync(target).equals(generated.wasm)
	)
		stale.push("dist/program.wasm");
	return stale;
}
