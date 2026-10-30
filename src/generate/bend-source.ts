// Reads the parts of a kernel's main.bend the generator needs: its `Data`
// types and the entry def's signature. It supports a subset on purpose and
// names anything else it meets. The generator then asks Bend to confirm this
// reading (see probeSource), so a parsing mistake here fails the build
// instead of producing wrong checks.

export type Scalar = "Nat" | "Bool" | "U32" | "F32" | "String";

export type FieldType =
	| { readonly kind: Scalar }
	| { readonly kind: "List"; readonly item: FieldType }
	| { readonly kind: "Maybe"; readonly item: FieldType }
	| {
			readonly kind: "Data";
			readonly name: string;
			readonly args: readonly FieldType[];
	  }
	| { readonly kind: "Param"; readonly name: string };

export interface Field {
	readonly name: string;
	readonly type: FieldType;
}

export interface Constructor {
	readonly name: string;
	readonly fields: readonly Field[];
}

/**
 * How a Bend type looks in TypeScript:
 * record: one constructor with fields, a plain object.
 * enum: no constructor has fields, a string union.
 * union: anything else, objects tagged by `kind`.
 */
export type Shape = "record" | "enum" | "union";

export interface DataType {
	readonly name: string;
	/** Type parameters, each declared `-A: Data`. */
	readonly params: readonly string[];
	readonly shape: Shape;
	readonly constructors: readonly Constructor[];
}

export interface Entry {
	readonly name: string;
	readonly param: Field;
	/** Bend's quantity annotations on Result, e.g. ["&1", "&1"], kept for the probe. */
	readonly quantities: readonly [string, string];
	readonly refusal: FieldType;
	readonly value: FieldType;
}

export interface KernelSource {
	readonly types: ReadonlyMap<string, DataType>;
	readonly entry: Entry;
}

export class UnsupportedBendError extends Error {
	override name = "UnsupportedBendError";
}

const SCALARS: readonly Scalar[] = ["Nat", "Bool", "U32", "F32", "String"];
const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const IDENT = new RegExp(`^${NAME}$`);
// Generated TypeScript uses these names itself.
const RESERVED = new Set(["tw", "kernel"]);

const unsupported = (line: number, message: string): never => {
	throw new UnsupportedBendError(`main.bend:${line}: ${message}`);
};

function splitTopLevel(text: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of text) {
		if ("<({[".includes(ch)) depth++;
		if (">)}]".includes(ch)) depth--;
		if (ch === "," && depth === 0) {
			out.push(current.trim());
			current = "";
		} else current += ch;
	}
	if (current.trim()) out.push(current.trim());
	return out;
}

/** What a type expression may refer to. */
interface Scope {
	readonly arity: ReadonlyMap<string, number>;
	readonly params: ReadonlySet<string>;
	readonly line: number;
}

/**
 * Parses a type expression: `Nat`, `+List<Nat>`, `List<&2, String>`,
 * `Maybe<&2, Limit<Res>>`, `A` (a type parameter).
 */
function parseType(text: string, scope: Scope): FieldType {
	const tokens = text.match(/&\d+|[A-Za-z_][A-Za-z0-9_]*|[<>,+]|\S/g) ?? [];
	let pos = 0;
	const peek = () => tokens[pos];
	const next = () => tokens[pos++] ?? "";
	const fail = (message: string): never =>
		unsupported(scope.line, `${message} in type ${text}`);

	const type = (): FieldType => {
		const plus = peek() === "+" && next() === "+";
		const name = next();
		if (!IDENT.test(name)) return fail(`expected a type name, got "${name}"`);
		const args: string[] = [];
		const types: FieldType[] = [];
		if (peek() === "<") {
			next();
			for (;;) {
				const t = peek() ?? "";
				if (t.startsWith("&")) args.push(next());
				else types.push(type());
				const sep = next();
				if (sep === ">") break;
				if (sep !== ",") return fail(`expected , or >`);
			}
		}
		const scalar = SCALARS.find((s) => s === name);
		if (scalar) {
			if (args.length || types.length || plus)
				return fail(`${name} takes no parameters`);
			return { kind: scalar };
		}
		if (name === "List" || name === "Maybe") {
			// Inside a Data record the element must be copyable: &2, or the + short form.
			const quantityOk = plus
				? args.length === 0
				: args.length === 1 && args[0] === "&2";
			if (!quantityOk || types.length !== 1)
				return fail(`write ${name}<&2, T> or +${name}<T>`);
			const item = types[0] ?? fail("missing element type");
			if (name === "Maybe" && item.kind === "Maybe")
				return fail(
					"Maybe<Maybe<T>> can't be told apart from Maybe<T> as T | null",
				);
			return { kind: name, item };
		}
		if (scope.params.has(name)) {
			if (args.length || types.length)
				return fail(`type parameter ${name} takes no parameters`);
			return { kind: "Param", name };
		}
		const arity = scope.arity.get(name);
		if (arity === undefined)
			return fail(
				`type ${name} is not supported here; use Nat, Bool, U32, F32, String, List, Maybe or a Data type declared in main.bend`,
			);
		if (args.length) return fail(`${name} takes no quantities`);
		if (types.length !== arity)
			return fail(`${name} takes ${arity} type parameter(s)`);
		return { kind: "Data", name, args: types };
	};

	const result = type();
	if (pos !== tokens.length) return fail(`unexpected "${tokens[pos]}"`);
	return result;
}

export function parseKernelSource(
	source: string,
	entryName: string,
): KernelSource {
	const lines = source.split("\n").map((l) => l.replace(/#.*$/, "").trimEnd());
	const rawTypes: {
		name: string;
		params: string[];
		line: number;
		ctors: { name: string; fields: string[]; line: number }[];
	}[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (!line.startsWith("type ")) continue;
		const m = new RegExp(`^type (${NAME})(?:<(.*)>)? is ([A-Za-z]+):$`).exec(
			line,
		);
		if (!m) {
			unsupported(i + 1, `expected "type Name is Data:": ${line.trim()}`);
			continue;
		}
		const [, name = "", paramText, kind = ""] = m;
		if (kind !== "Data")
			unsupported(
				i + 1,
				`type ${name} is ${kind}: only Data types are supported`,
			);
		const params = (paramText ? splitTopLevel(paramText) : []).map((p) => {
			const pm = /^-([A-Z][A-Za-z0-9_]*)\s*:\s*Data$/.exec(p);
			return (
				pm?.[1] ??
				unsupported(
					i + 1,
					`type parameters must be written -A: Data, got "${p}"`,
				)
			);
		});
		const ctors: { name: string; fields: string[]; line: number }[] = [];
		while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? "")) {
			i++;
			const body = (lines[i] ?? "").trim();
			const c = new RegExp(`^(${NAME})\\{(.*)\\}$`).exec(body);
			if (!c) {
				unsupported(
					i + 1,
					`expected a constructor like Name{field: Type}: ${body}`,
				);
				continue;
			}
			ctors.push({
				name: c[1] ?? "",
				fields: splitTopLevel(c[2] ?? ""),
				line: i + 1,
			});
		}
		if (ctors.length === 0)
			unsupported(i + 1, `type ${name} has no constructors`);
		rawTypes.push({ name, params, line: i + 1, ctors });
	}

	const arity = new Map(rawTypes.map((t) => [t.name, t.params.length]));
	const types = new Map<string, DataType>();
	const ctorNames = new Set<string>();
	for (const t of rawTypes) {
		if (RESERVED.has(t.name))
			unsupported(t.line, `type name ${t.name} is reserved`);
		const constructors: Constructor[] = t.ctors.map((c) => {
			if (ctorNames.has(c.name))
				unsupported(c.line, `constructor ${c.name} is declared twice`);
			ctorNames.add(c.name);
			const scope = { arity, params: new Set(t.params), line: c.line };
			const fields = c.fields.map((f): Field => {
				const fm = new RegExp(`^(${NAME})\\s*:\\s*(.+)$`).exec(f);
				if (!fm)
					return unsupported(c.line, `expected "name: Type", got "${f}"`);
				return { name: fm[1] ?? "", type: parseType(fm[2] ?? "", scope) };
			});
			const names = new Set(fields.map((f) => f.name));
			if (names.size !== fields.length)
				unsupported(c.line, `constructor ${c.name} repeats a field name`);
			return { name: c.name, fields };
		});
		const shape: Shape = constructors.every((c) => c.fields.length === 0)
			? "enum"
			: constructors.length === 1
				? "record"
				: "union";
		if (shape === "union")
			for (const c of constructors)
				if (c.fields.some((f) => f.name === "kind"))
					unsupported(
						t.line,
						`constructor ${c.name} has a field named "kind", which TypeScript uses to tell ${t.name}'s constructors apart`,
					);
		types.set(t.name, {
			name: t.name,
			params: t.params,
			shape,
			constructors,
		});
	}

	if (!IDENT.test(entryName))
		throw new UnsupportedBendError(`invalid entry name ${entryName}`);
	const header = lines.findIndex((l) => l.startsWith(`def ${entryName}(`));
	if (header < 0)
		throw new UnsupportedBendError(`main.bend has no def ${entryName}`);
	const sig = new RegExp(`^def ${entryName}\\((.*)\\)\\s*->\\s*(.+):$`).exec(
		lines[header] ?? "",
	);
	if (!sig)
		return unsupported(
			header + 1,
			`the signature of ${entryName} must fit on one line`,
		);
	const params = splitTopLevel(sig[1] ?? "");
	if (params.length !== 1)
		unsupported(
			header + 1,
			`${entryName} must take exactly one input (a record mirroring the app's input); it takes ${params.length}`,
		);
	const pm = new RegExp(`^[+~-]?(${NAME})\\s*:\\s*(.+)$`).exec(params[0] ?? "");
	if (!pm)
		return unsupported(header + 1, `expected "name: Type", got "${params[0]}"`);
	const rm = /^Result<\s*(&\d+)\s*,\s*(&\d+)\s*,\s*(.+)>$/.exec(sig[2] ?? "");
	const resultArgs = rm ? splitTopLevel(rm[3] ?? "") : [];
	if (!rm || resultArgs.length !== 2)
		return unsupported(
			header + 1,
			`${entryName} must return Bend's Result<&q, &q, Refusal, Value>: Done{value} approves, Fail{error} refuses`,
		);
	const scope = { arity, params: new Set<string>(), line: header + 1 };
	return {
		types,
		entry: {
			name: entryName,
			param: { name: pm[1] ?? "", type: parseType(pm[2] ?? "", scope) },
			quantities: [rm[1] ?? "", rm[2] ?? ""],
			refusal: parseType(resultArgs[0] ?? "", scope),
			value: parseType(resultArgs[1] ?? "", scope),
		},
	};
}

/** The type as Bend spells it, with declared types under the `ns` import alias. */
export function bendType(t: FieldType, ns: string): string {
	switch (t.kind) {
		case "List":
		case "Maybe":
			return `${t.kind}<&2, ${bendType(t.item, ns)}>`;
		case "Data":
			return t.args.length
				? `${ns}.${t.name}<${t.args.map((a) => bendType(a, ns)).join(", ")}>`
				: `${ns}.${t.name}`;
		case "Param":
			return t.name;
		default:
			return t.kind;
	}
}

/**
 * A Bend file that only checks if this reading of main.bend is right: every
 * constructor takes these fields with these types, every type has exactly
 * these constructors (a match must cover them all), and the entry has this
 * signature. Bend checking it is what lets the generator trust the parser.
 */
export function probeSource(kernel: KernelSource): string {
	const out = ["import Base", "import ./main.bend as K", ""];
	for (const t of kernel.types.values()) {
		const typeParams = t.params.map((p) => `-${p}: Data`);
		const self = t.params.length
			? `K.${t.name}<${t.params.join(", ")}>`
			: `K.${t.name}`;
		for (const c of t.constructors) {
			const params = [
				...typeParams,
				...c.fields.map((f) => `${f.name}: ${bendType(f.type, "K")}`),
			].join(", ");
			const args = c.fields.map((f) => f.name).join(", ");
			out.push(
				`def probe_ctor_${c.name}(${params}) -> ${self}:`,
				`  K.${c.name}{${args}}`,
				"",
			);
		}
		out.push(
			`def probe_cases_${t.name}(${[...typeParams, `v: ${self}`].join(", ")}) -> Nat:`,
			"  match v:",
		);
		for (const c of t.constructors)
			out.push(
				`    case K.${c.name}{${c.fields.map((f) => f.name).join(", ")}}:`,
				"      0n",
			);
		out.push("");
	}
	const e = kernel.entry;
	out.push(
		`def probe_entry(x: ${bendType(e.param.type, "K")}) -> Result<${e.quantities[0]}, ${e.quantities[1]}, ${bendType(e.refusal, "K")}, ${bendType(e.value, "K")}>:`,
		`  K.${e.name}(x)`,
		"",
	);
	return out.join("\n");
}
