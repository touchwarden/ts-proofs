// Runtime for generated kernel modules. App code uses `Approved<typeof k.rule>`
// and `k.rule.consume(a)`; only generated code calls `defineDecider`.

import { KernelInputError } from "./codec.ts";

export {
	inputCodec,
	KernelInputError,
	KernelOutputError,
	outputCodec,
	type Parser,
	toBendList,
	toBendMaybe,
} from "./codec.ts";

/**
 * The Standard Schema interface (standardschema.dev), copied as its spec
 * allows, so Zod-style tooling (Hono, form libraries) can run a kernel's
 * input check at the edge.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
	readonly "~standard": {
		readonly version: 1;
		readonly vendor: string;
		readonly validate: (
			value: unknown,
		) =>
			| { readonly value: Output; readonly issues?: undefined }
			| { readonly issues: readonly { readonly message: string }[] };
		readonly types?:
			| { readonly input: Input; readonly output: Output }
			| undefined;
	};
}

export function standardSchema<T>(
	parse: (value: unknown, at: string) => T,
): StandardSchemaV1<T> {
	return {
		"~standard": {
			version: 1,
			vendor: "touchwarden",
			validate(value) {
				try {
					return { value: parse(value, "input") };
				} catch (error) {
					if (error instanceof KernelInputError)
						return { issues: [{ message: error.message }] };
					throw error;
				}
			},
		},
	};
}

// Never exported, so no other module can write this key: an approval can only
// come from `defineDecider`, or from a cast the rule pack flags.
declare const APPROVED: unique symbol;

export interface Approval<Rule extends string, Input, Value> {
	/** Deep-frozen copy of the input the kernel decided on. */
	readonly input: Readonly<Input>;
	/** The value inside the kernel's `Done{…}`, deep-frozen. */
	readonly result: Value;
	readonly [APPROVED]: Rule;
}

export type Decided<Rule extends string, Input, Value, Refusal> =
	| { readonly ok: true; readonly approval: Approval<Rule, Input, Value> }
	| { readonly ok: false; readonly result: Refusal };

/**
 * A kernel's answer, decoded: Bend's `Done{value}` or Lean's `.ok value`
 * approves; `Fail{error}` or `.error e` refuses.
 */
export type Outcome<Value, Refusal> =
	| { readonly done: true; readonly value: Value }
	| { readonly done: false; readonly error: Refusal };

export interface Decider<Rule extends string, Input, Value, Refusal> {
	(input: Input): Decided<Rule, Input, Value, Refusal>;
	readonly rule: Rule;
	/** Checks the approval came from this decider in this process and spends it. */
	consume(approval: Approval<Rule, Input, Value>): Approval<Rule, Input, Value>;
}

/** A decider whose kernel answers asynchronously, e.g. Lean compiled to wasm. */
export interface AsyncDecider<Rule extends string, Input, Value, Refusal> {
	(input: Input): Promise<Decided<Rule, Input, Value, Refusal>>;
	readonly rule: Rule;
	/** Checks the approval came from this decider in this process and spends it. */
	consume(approval: Approval<Rule, Input, Value>): Approval<Rule, Input, Value>;
}

export type Approved<D> =
	D extends Decider<infer R, infer I, infer V, infer _E>
		? Approval<R, I, V>
		: D extends AsyncDecider<infer R, infer I, infer V, infer _E>
			? Approval<R, I, V>
			: never;

export class ForgedApprovalError extends Error {
	override name = "ForgedApprovalError";
}

/**
 * The compiled kernel stopped instead of answering. Bend's JavaScript throws
 * a bare string when a sum or product passes 2^48-1, where the proofs'
 * unbounded numbers would carry on; nothing is approved.
 */
export class KernelRuntimeError extends Error {
	override name = "KernelRuntimeError";
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const v of Object.values(value)) deepFreeze(v);
		Object.freeze(value);
	}
	return value;
}

// The decision steps both decider kinds share. One registry per decider: an
// approval is only accepted by the decider that issued it, and only once.
function issuer<Rule extends string, Input, Value, Refusal>(
	rule: Rule,
	parse: (value: unknown, at: string) => Input,
) {
	const issued = new WeakSet<object>();
	return {
		// Clone first, so getters run once and the checks see one snapshot.
		prepare: (input: Input) =>
			deepFreeze(parse(structuredClone(input), "input")),
		settle(
			frozen: Input,
			outcome: Outcome<Value, Refusal>,
		): Decided<Rule, Input, Value, Refusal> {
			if (!outcome.done) return { ok: false, result: outcome.error };
			// The library's one cast: the only place the brand is created.
			const approval = Object.freeze({
				input: frozen,
				result: deepFreeze(outcome.value),
			}) as Approval<Rule, Input, Value>;
			issued.add(approval);
			return { ok: true, approval };
		},
		failed(error: unknown): never {
			if (error instanceof Error) throw error;
			throw new KernelRuntimeError(`${rule}: ${String(error)}`);
		},
		consume(approval: Approval<Rule, Input, Value>) {
			if (!issued.delete(approval))
				throw new ForgedApprovalError(
					`${rule}: approval was not issued by this decider, or was already used`,
				);
			return approval;
		},
	};
}

/**
 * `parse` checks the input and builds a fresh value from it; `run` gets that
 * value, already frozen, and calls the kernel. The approval records the same
 * value, so it holds exactly what the kernel decided on (for example an F32
 * after rounding), with nothing the caller can still change.
 */
export function defineDecider<Rule extends string, Input, Value, Refusal>(
	rule: Rule,
	parse: (value: unknown, at: string) => Input,
	run: (input: Input) => Outcome<Value, Refusal>,
): Decider<Rule, Input, Value, Refusal> {
	const steps = issuer<Rule, Input, Value, Refusal>(rule, parse);
	const decide = (input: Input): Decided<Rule, Input, Value, Refusal> => {
		const frozen = steps.prepare(input);
		let outcome: Outcome<Value, Refusal>;
		try {
			outcome = run(frozen);
		} catch (error) {
			return steps.failed(error);
		}
		return steps.settle(frozen, outcome);
	};
	return Object.assign(decide, { rule, consume: steps.consume });
}

/** `defineDecider` for a kernel that answers with a promise. */
export function defineAsyncDecider<Rule extends string, Input, Value, Refusal>(
	rule: Rule,
	parse: (value: unknown, at: string) => Input,
	run: (input: Input) => Promise<Outcome<Value, Refusal>>,
): AsyncDecider<Rule, Input, Value, Refusal> {
	const steps = issuer<Rule, Input, Value, Refusal>(rule, parse);
	const decide = async (
		input: Input,
	): Promise<Decided<Rule, Input, Value, Refusal>> => {
		const frozen = steps.prepare(input);
		let outcome: Outcome<Value, Refusal>;
		try {
			outcome = await run(frozen);
		} catch (error) {
			return steps.failed(error);
		}
		return steps.settle(frozen, outcome);
	};
	return Object.assign(decide, { rule, consume: steps.consume });
}
