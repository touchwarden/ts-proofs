// prove.json: the rules a repository proves. `prove check` always reads it
// from the base branch, so a PR cannot drop or loosen the rules it is judged by.

import { type BackendId, isBackendId } from "./backends/index.ts";
import type { ProofGate } from "./gate.ts";

export interface Rule {
	id: string;
	/** One sentence a reviewer can check the law against. */
	statement: string;
	backend: BackendId;
	/** Directory holding the laws and proof files, relative to the repo root. */
	kernel: string;
	/** Law name in the laws file, e.g. never_exceeds. */
	law: string;
	/** The compiled kernel the app runs; checked to be a fresh build of the proven source. */
	generated?: string;
	/** For `prove generate`: the deciding function (Bend def, or full Lean name). */
	entry?: string;
	/** Name of the generated approval type, e.g. RefundApproved. */
	proofType?: string;
	/** TypeScript call sites that must hold an approval. */
	gate?: Omit<ProofGate, "proof"> & { proof?: string };
}

export interface Config {
	rules: Rule[];
}

const safePath = (value: unknown): value is string =>
	typeof value === "string" &&
	value.length > 0 &&
	!value.includes("\0") &&
	!value.startsWith("/") &&
	!value.split(/[\\/]/).includes("..");
const name = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

function gate(value: unknown, at: string): Rule["gate"] {
	if (value === undefined) return undefined;
	if (
		!isObject(value) ||
		!safePath(value.project) ||
		!Array.isArray(value.trusted) ||
		value.trusted.length === 0 ||
		!value.trusted.every(safePath) ||
		(value.proof !== undefined &&
			(typeof value.proof !== "string" || !name.test(value.proof)))
	)
		throw new Error(
			`${at}.gate needs a project directory, a non-empty list of trusted files and an optional proof type name`,
		);
	const out: NonNullable<Rule["gate"]> = {
		project: value.project,
		trusted: value.trusted,
	};
	if (typeof value.proof === "string") out.proof = value.proof;
	if (value.sink !== undefined) {
		const sink = value.sink;
		if (
			!isObject(sink) ||
			typeof sink.call !== "string" ||
			!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(sink.call) ||
			typeof sink.only_in !== "string" ||
			!name.test(sink.only_in)
		)
			throw new Error(
				`${at}.gate.sink needs call (a.b.c) and only_in (a function name)`,
			);
		out.sink = { call: sink.call, only_in: sink.only_in };
	}
	return out;
}

export function parseConfig(text: string): Config {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new Error(
			`prove.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isObject(raw) || !Array.isArray(raw.rules) || raw.rules.length === 0)
		throw new Error("prove.json needs a non-empty rules list");
	const ids = new Set<string>();
	const rules = raw.rules.map((r: unknown, index): Rule => {
		const at = `rules[${index}]`;
		if (!isObject(r)) throw new Error(`${at} must be an object`);
		if (typeof r.id !== "string" || !/^[a-z0-9][a-z0-9.-]*$/.test(r.id))
			throw new Error(
				`${at}.id must be lowercase letters, digits, dots and dashes`,
			);
		if (ids.has(r.id)) throw new Error(`${at}.id ${r.id} is used twice`);
		ids.add(r.id);
		if (typeof r.statement !== "string" || !r.statement.trim())
			throw new Error(`${at}.statement must say what the law guarantees`);
		if (!isBackendId(r.backend))
			throw new Error(`${at}.backend must be bend, lean or lasm`);
		if (!safePath(r.kernel))
			throw new Error(`${at}.kernel must be a repository-relative directory`);
		if (typeof r.law !== "string" || !name.test(r.law.replace(/^Laws\./, "")))
			throw new Error(`${at}.law must be a law name`);
		if (r.generated !== undefined && !safePath(r.generated))
			throw new Error(`${at}.generated must be a repository-relative file`);
		if (r.generated !== undefined && r.backend === "lean")
			throw new Error(
				`${at}: a lean rule proves a model; nothing the app runs is built from it, so it has no generated kernel`,
			);
		if (
			r.entry !== undefined &&
			(typeof r.entry !== "string" || !/^[A-Za-z_][\w.]*$/.test(r.entry))
		)
			throw new Error(`${at}.entry must be a function name`);
		if (
			r.proofType !== undefined &&
			(typeof r.proofType !== "string" || !name.test(r.proofType))
		)
			throw new Error(`${at}.proofType must be a TypeScript type name`);
		const rule: Rule = {
			id: r.id,
			statement: r.statement,
			backend: r.backend,
			kernel: r.kernel.replace(/\/$/, ""),
			law: r.law.replace(/^Laws\./, ""),
		};
		if (typeof r.generated === "string") rule.generated = r.generated;
		if (typeof r.entry === "string") rule.entry = r.entry;
		if (typeof r.proofType === "string") rule.proofType = r.proofType;
		const g = gate(r.gate, at);
		if (g) {
			if (!g.proof && !rule.proofType)
				throw new Error(
					`${at}.gate needs a proof type: set proofType on the rule or gate.proof`,
				);
			rule.gate = g;
		}
		return rule;
	});
	return { rules };
}
