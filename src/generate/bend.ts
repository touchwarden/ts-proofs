// Turns a proven Bend kernel directory (main.bend, LAWS.bend, PROOF.bend)
// into files an app imports. It refuses to generate unless Bend says every
// law holds and Bend confirms the generator read main.bend's types correctly.
//
//   <name>.mjs        Bend's compiled module, byte for byte
//   <name>.d.mts      types the raw module as unknown in, unknown out
//   <name>.gen.ts     app types, input and output checks, the decider
//   <name>.meta.json  Bend version, hashes, laws

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	bendType,
	type DataType,
	type FieldType,
	type KernelSource,
	parseKernelSource,
	probeSource,
} from "./bend-source.ts";

export interface GenerateOptions {
	/** The kernel directory; its name becomes the module name. */
	readonly dir: string;
	/** The def that decides, e.g. "withdraw". */
	readonly entry: string;
	/** Import specifier for the runtime. */
	readonly runtime?: string;
	/** Bend command; defaults to $PROVE_BEND, then `bend`. */
	readonly bend?: readonly string[];
	/** Name of the exported approval type; defaults to <Name>Approved. */
	readonly proofType?: string;
}

export interface GeneratedKernel {
	readonly name: string;
	readonly rule: string;
	/** File name (inside dir) to contents. */
	readonly files: ReadonlyMap<string, string>;
}

export class KernelBuildError extends Error {
	override name = "KernelBuildError";
}

const SOURCES = ["main.bend", "LAWS.bend", "PROOF.bend"] as const;
const VERDICT = /^ALL PROOFS CHECK$/m;

const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

function bendCommand(options: GenerateOptions): readonly string[] {
	if (options.bend?.length) return options.bend;
	const env = (process.env.PROVE_BEND || process.env.TOUCHWARDEN_BEND)?.trim();
	return env ? env.split(/\s+/) : ["bend"];
}

export function moduleName(dir: string): string {
	const base = path.basename(path.resolve(dir));
	const name = base.replace(/[-_]+([a-zA-Z0-9])/g, (_, c: string) =>
		c.toUpperCase(),
	);
	if (!/^[a-z][A-Za-z0-9]*$/.test(name))
		throw new KernelBuildError(
			`kernel directory name ${base} must start with a lowercase letter`,
		);
	return name;
}

export function generateKernel(options: GenerateOptions): GeneratedKernel {
	const dir = path.resolve(options.dir);
	const name = moduleName(dir);
	const rule = `${name}.${options.entry}`;
	for (const file of SOURCES)
		if (!existsSync(path.join(dir, file)))
			throw new KernelBuildError(
				`${dir} has no ${file}; a kernel needs main.bend, LAWS.bend and PROOF.bend`,
			);
	const [command = "bend", ...prefix] = bendCommand(options);

	// Work on a copy: the probe file sits beside main.bend, and nothing is
	// written into the kernel directory until everything has passed.
	const work = mkdtempSync(path.join(os.tmpdir(), "prove-kernel-"));
	try {
		for (const file of SOURCES)
			copyFileSync(path.join(dir, file), path.join(work, file));
		const bend = (args: readonly string[]) => {
			const r = spawnSync(command, [...prefix, ...args], {
				cwd: work,
				encoding: "utf8",
				timeout: 120_000,
				// No hub fetches during a build, no telemetry.
				env: {
					...process.env,
					BEND_HUB: "http://127.0.0.1:9",
					BEND_LIB: path.join(work, ".bend-lib"),
					BEND_TELEMETRY: "0",
					DO_NOT_TRACK: "1",
				},
			});
			if (r.error)
				throw new KernelBuildError(
					`could not run ${command}: ${r.error.message}`,
				);
			return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` };
		};

		// Read the types first: an unsupported construct gets a clear message
		// rather than whatever Bend says about it.
		const kernel = parseKernelSource(
			readFileSync(path.join(work, "main.bend"), "utf8"),
			options.entry,
		);

		// Bend prints ALL PROOFS CHECK for a LAWS.bend with no laws in it, so
		// "every law holds" would be true of a kernel that promises nothing.
		const laws = [
			...readFileSync(path.join(work, "LAWS.bend"), "utf8").matchAll(
				/^law\s+([^\s:]+)\s*:/gm,
			),
		].map((m) => m[1] ?? "");
		if (laws.length === 0)
			throw new KernelBuildError(
				"LAWS.bend states no laws, so the kernel proves nothing; nothing was generated",
			);

		const proof = bend(["PROOF.bend", "--check-only"]);
		if (!proof.ok || !VERDICT.test(proof.output))
			throw new KernelBuildError(
				`Bend did not accept the proofs, so nothing was generated:\n${proof.output}`,
			);

		writeFileSync(path.join(work, "probe.bend"), probeSource(kernel));
		const probe = bend(["probe.bend", "--check-only"]);
		if (!probe.ok || !VERDICT.test(probe.output))
			throw new KernelBuildError(
				`Bend disagrees with the generator's reading of main.bend, so nothing was generated:\n${probe.output}`,
			);

		const compiled = bend(["main.bend", "-o", path.join(work, "out.mjs")]);
		if (!compiled.ok)
			throw new KernelBuildError(
				`Bend could not compile main.bend:\n${compiled.output}`,
			);
		const mjs = readFileSync(path.join(work, "out.mjs"), "utf8");
		const version = /bend (\d+\.\d+\.\d+)/.exec(bend(["version"]).output)?.[1];
		if (!version) throw new KernelBuildError("could not read the Bend version");

		const meta = {
			generator: "@touchwarden/prove",
			rule,
			entry: options.entry,
			bend: version,
			proofs: "ALL PROOFS CHECK (bend --check-only)",
			laws,
			sources: Object.fromEntries(
				SOURCES.map((file) => [
					file,
					sha256(readFileSync(path.join(work, file), "utf8")),
				]),
			),
			module: { file: `${name}.mjs`, sha256: sha256(mjs) },
		};
		const files = new Map<string, string>([
			[`${name}.mjs`, mjs],
			[`${name}.d.mts`, declaration(kernel)],
			[
				`${name}.gen.ts`,
				emitModule({
					kernel,
					name,
					rule,
					runtime: options.runtime ?? "@touchwarden/prove/runtime",
					proofType:
						options.proofType ??
						`${name.charAt(0).toUpperCase()}${name.slice(1)}Approved`,
					meta,
				}),
			],
			[`${name}.meta.json`, `${JSON.stringify(meta, null, "\t")}\n`],
		]);
		return { name, rule, files };
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/** Writes the generated files into the kernel directory. */
export function writeKernel(dir: string, generated: GeneratedKernel): string[] {
	const written: string[] = [];
	for (const [file, text] of generated.files) {
		writeFileSync(path.join(dir, file), text);
		written.push(file);
	}
	return written;
}

/** Files on disk that differ from a fresh generation (for CI). */
export function staleFiles(dir: string, generated: GeneratedKernel): string[] {
	return [...generated.files].flatMap(([file, text]) => {
		const target = path.join(dir, file);
		return existsSync(target) && readFileSync(target, "utf8") === text
			? []
			: [file];
	});
}

function declaration(kernel: KernelSource): string {
	return [
		"// GENERATED by @touchwarden/prove. Do not edit.",
		"// Bend's module is untyped. Only the entry is visible, and only as",
		"// unknown in, unknown out: the .gen.ts module checks both sides.",
		`declare const kernel: { readonly ${kernel.entry.name}: (input: unknown) => unknown };`,
		"export default kernel;",
		"",
	].join("\n");
}

// Code emission
// =============
//
// Each Data type gets up to three functions, generic types taking one helper
// per type parameter:
//   parseT(v, at, ...)     app value -> checked app value (KernelInputError)
//   toBendT(v, ...)        checked app value -> Bend's encoding
//   fromBendT(v, at, ...)  Bend's answer -> checked app value (KernelOutputError)

export const q = JSON.stringify;
export const list = (items: readonly string[]) =>
	`[${items.map((i) => q(i)).join(", ")}] as const`;

export function tsType(t: FieldType): string {
	switch (t.kind) {
		case "Nat":
		case "U32":
		case "F32":
			return "number";
		case "Bool":
			return "boolean";
		case "String":
			return "string";
		case "List":
			return `ReadonlyArray<${tsType(t.item)}>`;
		case "Maybe":
			return `${tsType(t.item)} | null`;
		case "Data":
			return t.args.length
				? `${t.name}<${t.args.map(tsType).join(", ")}>`
				: t.name;
		case "Param":
			return t.name;
	}
}

/** Data types reachable from the roots, in declaration order. */
export function reachable(
	kernel: KernelSource,
	roots: readonly FieldType[],
): DataType[] {
	const seen = new Set<string>();
	const visit = (t: FieldType): void => {
		if (t.kind === "List" || t.kind === "Maybe") {
			visit(t.item);
			return;
		}
		if (t.kind !== "Data") return;
		for (const a of t.args) visit(a);
		if (seen.has(t.name)) return;
		seen.add(t.name);
		for (const c of kernel.types.get(t.name)?.constructors ?? [])
			for (const f of c.fields) visit(f.type);
	};
	for (const root of roots) visit(root);
	return [...kernel.types.values()].filter((t) => seen.has(t.name));
}

const generics = (t: DataType) =>
	t.params.length ? `<${t.params.join(", ")}>` : "";

/** Expression checking `value` (at path `at`) as `t`, on the app side. */
function parseExpr(t: FieldType, value: string, at: string): string {
	switch (t.kind) {
		case "Nat":
		case "Bool":
		case "U32":
		case "F32":
		case "String":
			return `i.${t.kind.toLowerCase()}(${value}, ${at})`;
		case "List":
		case "Maybe":
			return `i.${t.kind === "List" ? "list" : "maybe"}(${value}, ${at}, (x, at) => ${parseExpr(t.item, "x", "at")})`;
		case "Data":
			return `parse${t.name}(${[value, at, ...t.args.map((a) => `(x, at) => ${parseExpr(a, "x", "at")}`)].join(", ")})`;
		case "Param":
			return `p${t.name}(${value}, ${at})`;
	}
}

/** Expression converting a checked app value to Bend's encoding. */
function toBendExpr(t: FieldType, value: string): string {
	switch (t.kind) {
		case "List":
		case "Maybe":
			return `tw.toBend${t.kind}(${value}, (x) => ${toBendExpr(t.item, "x")})`;
		case "Data":
			return `toBend${t.name}(${[value, ...t.args.map((a) => `(x) => ${toBendExpr(a, "x")}`)].join(", ")})`;
		case "Param":
			return `t${t.name}(${value})`;
		default:
			return value;
	}
}

/** Expression checking a value from Bend and converting it to the app shape. */
function fromBendExpr(t: FieldType, value: string, at: string): string {
	switch (t.kind) {
		case "Nat":
		case "Bool":
		case "U32":
		case "F32":
		case "String":
			return `o.${t.kind.toLowerCase()}(${value}, ${at})`;
		case "List":
		case "Maybe":
			return `o.bend${t.kind}(${value}, ${at}, (x, at) => ${fromBendExpr(t.item, "x", "at")})`;
		case "Data":
			return `fromBend${t.name}(${[value, at, ...t.args.map((a) => `(x, at) => ${fromBendExpr(a, "x", "at")}`)].join(", ")})`;
		case "Param":
			return `f${t.name}(${value}, ${at})`;
	}
}

const fieldAt = (field: string) => `\`\${at}.${field}\``;

// A same-named object of the constructor names, so app code writes
// `Refusal.CrossTenant` instead of a bare string.
function tagConstants(t: DataType): string {
	const tags = t.constructors.map((c) => `\t${c.name}: ${q(c.name)},`);
	return [`export const ${t.name} = {`, ...tags, "} as const;"].join("\n");
}

export function typeDeclaration(t: DataType): string {
	const name = `${t.name}${generics(t)}`;
	if (t.shape === "record") return recordDeclaration(t, name);
	return `${tagConstants(t)}\n\n${unionDeclaration(t, name)}`;
}

function unionDeclaration(t: DataType, name: string): string {
	if (t.shape === "enum")
		return `export type ${name} = ${t.constructors.map((c) => q(c.name)).join(" | ")};`;
	const variants = t.constructors.map((c) => {
		const members = [
			`readonly kind: ${q(c.name)}`,
			...c.fields.map((f) => `readonly ${f.name}: ${tsType(f.type)}`),
		];
		return `{ ${members.join("; ")} }`;
	});
	return `export type ${name} =\n${variants.map((v) => `\t| ${v}`).join("\n")};`;
}

function recordDeclaration(t: DataType, name: string): string {
	const fields = t.constructors[0]?.fields ?? [];
	return [
		`export interface ${name} {`,
		...fields.map((f) => `\treadonly ${f.name}: ${tsType(f.type)};`),
		"}",
	].join("\n");
}

function signature(
	prefix: "parse" | "toBend" | "fromBend",
	t: DataType,
): string {
	const self = `${t.name}${generics(t)}`;
	const helpers = t.params.map((p) =>
		prefix === "toBend"
			? `t${p}: (value: ${p}) => unknown`
			: `${prefix === "parse" ? "p" : "f"}${p}: tw.Parser<${p}>`,
	);
	if (prefix === "toBend")
		return `function toBend${t.name}${generics(t)}(${[`v: ${self}`, ...helpers].join(", ")}): unknown {`;
	return `function ${prefix}${t.name}${generics(t)}(${["v: unknown", "at: string", ...helpers].join(", ")}): ${self} {`;
}

function parseFunction(t: DataType): string {
	const head = signature("parse", t);
	const check = (f: { name: string; type: FieldType }) =>
		parseExpr(f.type, `r.${f.name}`, fieldAt(f.name));
	if (t.shape === "enum")
		return `${head}\n\treturn i.oneOf(v, at, ${list(t.constructors.map((c) => c.name))});\n}`;
	if (t.shape === "record") {
		const fields = t.constructors[0]?.fields ?? [];
		return [
			head,
			`\tconst r = i.record(v, at, ${list(fields.map((f) => f.name))});`,
			"\treturn {",
			...fields.map((f) => `\t\t${f.name}: ${check(f)},`),
			"\t};",
			"}",
		].join("\n");
	}
	return [
		head,
		`\tconst { tag, fields: r } = i.tagged(v, at, "kind", ${list(t.constructors.map((c) => c.name))});`,
		"\tswitch (tag) {",
		...t.constructors.flatMap((c) => [
			`\t\tcase ${q(c.name)}:`,
			`\t\t\ti.sameKeys(r, at, ${list(["kind", ...c.fields.map((f) => f.name)])});`,
			`\t\t\treturn { kind: ${q(c.name)}${c.fields.map((f) => `, ${f.name}: ${check(f)}`).join("")} };`,
		]),
		"\t}",
		"}",
	].join("\n");
}

function toBendFunction(t: DataType): string {
	const head = signature("toBend", t);
	if (t.shape === "enum") return `${head}\n\treturn { $: v };\n}`;
	const encode = (c: DataType["constructors"][number]) =>
		`{ $: ${q(c.name)}${c.fields.map((f) => `, ${f.name}: ${toBendExpr(f.type, `v.${f.name}`)}`).join("")} }`;
	if (t.shape === "record") {
		const c = t.constructors[0];
		return c ? `${head}\n\treturn ${encode(c)};\n}` : "";
	}
	return [
		head,
		"\tswitch (v.kind) {",
		...t.constructors.flatMap((c) => [
			`\t\tcase ${q(c.name)}:`,
			`\t\t\treturn ${encode(c)};`,
		]),
		"\t}",
		"}",
	].join("\n");
}

function fromBendFunction(t: DataType): string {
	const head = signature("fromBend", t);
	const tags = list(t.constructors.map((c) => c.name));
	const build = (c: DataType["constructors"][number], withKind: boolean) =>
		`{ ${[
			...(withKind ? [`kind: ${q(c.name)}`] : []),
			...c.fields.map(
				(f) =>
					`${f.name}: ${fromBendExpr(f.type, `r.${f.name}`, fieldAt(f.name))}`,
			),
		].join(", ")} }`;
	if (t.shape === "enum")
		return [
			head,
			`\tconst { tag, fields } = o.tagged(v, at, "$", ${tags});`,
			'\to.sameKeys(fields, at, ["$"]);',
			"\treturn tag;",
			"}",
		].join("\n");
	if (t.shape === "record") {
		const c = t.constructors[0];
		if (!c) return "";
		return [
			head,
			`\tconst { fields: r } = o.tagged(v, at, "$", ${tags});`,
			`\to.sameKeys(r, at, ${list(["$", ...c.fields.map((f) => f.name)])});`,
			`\treturn ${build(c, false)};`,
			"}",
		].join("\n");
	}
	return [
		head,
		`\tconst { tag, fields: r } = o.tagged(v, at, "$", ${tags});`,
		"\tswitch (tag) {",
		...t.constructors.flatMap((c) => [
			`\t\tcase ${q(c.name)}:`,
			`\t\t\to.sameKeys(r, at, ${list(["$", ...c.fields.map((f) => f.name)])});`,
			`\t\t\treturn ${build(c, true)};`,
		]),
		"\t}",
		"}",
	].join("\n");
}

function emitModule(args: {
	kernel: KernelSource;
	name: string;
	rule: string;
	runtime: string;
	proofType: string;
	meta: { bend: string; laws: readonly string[]; module: { sha256: string } };
}): string {
	const { kernel, name, rule, runtime, proofType, meta } = args;
	const e = kernel.entry;
	const inputTypes = reachable(kernel, [e.param.type]);
	const outputTypes = reachable(kernel, [e.refusal, e.value]);
	const allTypes = reachable(kernel, [e.param.type, e.refusal, e.value]);
	const input = tsType(e.param.type);
	const value = tsType(e.value);
	const refusal = tsType(e.refusal);

	return [
		`// GENERATED by @touchwarden/prove from ${name}/main.bend. Do not edit:`,
		"// change the Bend sources and run `prove generate` again.",
		`// Bend ${meta.bend} | ${name}.mjs sha256 ${meta.module.sha256}`,
		`// Laws (ALL PROOFS CHECK): ${meta.laws.join(", ") || "(none)"}`,
		`// Entry: ${e.name}(${bendType(e.param.type, name)}) -> Result<${bendType(e.refusal, name)}, ${bendType(e.value, name)}>. Done approves, Fail refuses.`,
		`import * as tw from ${q(runtime)};`,
		`import kernel from "./${name}.mjs";`,
		"",
		"const i = tw.inputCodec;",
		"const o = tw.outputCodec;",
		"",
		...allTypes.map(typeDeclaration).flatMap((d) => [d, ""]),
		...inputTypes.flatMap((t) => [parseFunction(t), "", toBendFunction(t), ""]),
		...outputTypes.flatMap((t) => [fromBendFunction(t), ""]),
		`const parseInput = (v: unknown, at: string): ${input} => ${parseExpr(e.param.type, "v", "at")};`,
		"",
		`/** Standard Schema for ${e.name}'s input: the same check the decider runs. */`,
		`export const ${e.name}Input: tw.StandardSchemaV1<${input}> = tw.standardSchema(parseInput);`,
		"",
		`export const ${name} = {`,
		`\t${e.name}: tw.defineDecider(${q(rule)}, parseInput, (input: ${input}): tw.Outcome<${value}, ${refusal}> => {`,
		`\t\tconst out = kernel.${e.name}(${toBendExpr(e.param.type, "input")});`,
		'\t\tconst { tag, fields } = o.tagged(out, "result", "$", ["Done", "Fail"] as const);',
		'\t\tif (tag === "Done") {',
		'\t\t\to.sameKeys(fields, "result", ["$", "value"]);',
		`\t\t\treturn { done: true, value: ${fromBendExpr(e.value, "fields.value", '"result.value"')} };`,
		"\t\t}",
		'\t\to.sameKeys(fields, "result", ["$", "error"]);',
		`\t\treturn { done: false, error: ${fromBendExpr(e.refusal, "fields.error", '"result.error"')} };`,
		"\t}),",
		"};",
		"",
		"/** Proof that the proven kernel approved: require it where the decision is acted on. */",
		`export type ${proofType} = tw.Approved<typeof ${name}.${e.name}>;`,
		"",
	].join("\n");
}
