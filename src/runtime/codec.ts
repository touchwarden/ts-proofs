// Checks used by generated modules on both sides of a Bend kernel. Bend's
// compiled JavaScript checks none of this itself: a negative or fractional Nat
// inside a record, a missing field or an unknown tag reaches the kernel as is.

/** Input to a kernel was not a value its proof is about. The kernel did not run. */
export class KernelInputError extends Error {
	override name = "KernelInputError";
}

/** The kernel answered something its declared type does not allow. Never an approval. */
export class KernelOutputError extends Error {
	override name = "KernelOutputError";
}

/** Bend's runtime stops past this Nat; JavaScript numbers stay exact below 2^53. */
export const NAT_MAX = 2 ** 48 - 1;
export const U32_MAX = 2 ** 32 - 1;
/**
 * Bounds on input size, so one request can't make a kernel walk an unbounded
 * list or string. Generous for decision inputs; not yet configurable.
 */
export const MAX_LIST = 10_000;
export const MAX_STRING = 65_536;

export type Parser<T> = (value: unknown, at: string) => T;

type ErrorClass = new (message: string) => Error;
type Fields = Readonly<Record<string, unknown>>;

/** App array to Bend's list: Con{head, tail} cells ending in Nil. */
export function toBendList<T>(
	items: readonly T[],
	item: (value: T) => unknown,
): unknown {
	let list: unknown = { $: "Nil" };
	for (const value of [...items].reverse())
		list = { $: "Con", head: item(value), tail: list };
	return list;
}

/** App `T | null` to Bend's Maybe. */
export function toBendMaybe<T>(
	value: T | null,
	item: (value: T) => unknown,
): unknown {
	return value === null ? { $: "None" } : { $: "Some", value: item(value) };
}

function isPlainObject(value: unknown): value is Fields {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function makeCodec(ErrorType: ErrorClass) {
	const fail = (at: string, message: string): never => {
		throw new ErrorType(`${at}: ${message}`);
	};
	const sameKeys = (value: Fields, at: string, keys: readonly string[]) => {
		const got = Object.keys(value).sort();
		const want = [...keys].sort();
		if (got.length !== want.length || got.some((k, i) => k !== want[i]))
			fail(at, `expected exactly the fields ${want.join(", ") || "(none)"}`);
	};
	return {
		fail,
		nat(value: unknown, at: string): number {
			if (
				typeof value !== "number" ||
				!Number.isSafeInteger(value) ||
				value < 0 ||
				value > NAT_MAX
			)
				return fail(at, `expected a whole number from 0 to ${NAT_MAX}`);
			return value;
		},
		bool(value: unknown, at: string): boolean {
			if (typeof value !== "boolean") return fail(at, "expected true or false");
			return value;
		},
		u32(value: unknown, at: string): number {
			if (
				typeof value !== "number" ||
				!Number.isInteger(value) ||
				value < 0 ||
				value > U32_MAX
			)
				return fail(at, `expected a whole number from 0 to ${U32_MAX}`);
			return value;
		},
		/**
		 * A finite number, rounded to 32 bits. NaN is refused because every
		 * comparison with it is false, so a "too high" check never fires: a
		 * broken sensor would pass. Rounding here means the approval records
		 * the value the kernel's F32 maths works on.
		 */
		f32(value: unknown, at: string): number {
			const rounded =
				typeof value === "number" ? Math.fround(value) : Number.NaN;
			if (!Number.isFinite(rounded))
				return fail(at, "expected a finite number within 32-bit float range");
			return rounded;
		},
		string(value: unknown, at: string): string {
			if (typeof value !== "string") return fail(at, "expected a string");
			if (value.length > MAX_STRING)
				return fail(at, `expected at most ${MAX_STRING} characters`);
			return value;
		},
		/** An app array, each item checked. */
		list<T>(value: unknown, at: string, item: Parser<T>): readonly T[] {
			if (!Array.isArray(value)) return fail(at, "expected an array");
			if (value.length > MAX_LIST)
				return fail(at, `expected at most ${MAX_LIST} items`);
			return value.map((v: unknown, i) => item(v, `${at}[${i}]`));
		},
		/** An app `T | null`. `undefined` is refused, so a missing field can't pass as "none". */
		maybe<T>(value: unknown, at: string, item: Parser<T>): T | null {
			return value === null ? null : item(value, at);
		},
		/** Bend's list (Con/Nil cells) back to an array, each item checked. */
		bendList<T>(value: unknown, at: string, item: Parser<T>): readonly T[] {
			const out: T[] = [];
			let cell = value;
			for (;;) {
				if (!isPlainObject(cell)) return fail(at, "expected a Bend list");
				if (cell.$ === "Nil" && Object.keys(cell).length === 1) return out;
				if (cell.$ !== "Con") return fail(at, "expected a Bend list");
				sameKeys(cell, at, ["$", "head", "tail"]);
				if (out.length === MAX_LIST)
					return fail(at, `expected at most ${MAX_LIST} items`);
				out.push(item(cell.head, `${at}[${out.length}]`));
				cell = cell.tail;
			}
		},
		/** Bend's Maybe (None / Some{value}) back to `T | null`. */
		bendMaybe<T>(value: unknown, at: string, item: Parser<T>): T | null {
			if (!isPlainObject(value)) return fail(at, "expected a Bend Maybe");
			if (value.$ === "None" && Object.keys(value).length === 1) return null;
			if (value.$ !== "Some") return fail(at, "expected a Bend Maybe");
			sameKeys(value, at, ["$", "value"]);
			return item(value.value, at);
		},
		/** A plain object with exactly these fields. */
		record(value: unknown, at: string, keys: readonly string[]): Fields {
			if (!isPlainObject(value)) return fail(at, "expected an object");
			sameKeys(value, at, keys);
			return value;
		},
		/** One of these strings. */
		oneOf<T extends string>(
			value: unknown,
			at: string,
			options: readonly T[],
		): T {
			const found = options.find((o) => o === value);
			if (found === undefined)
				return fail(at, `expected one of ${options.join(", ")}`);
			return found;
		},
		/** A plain object whose `field` is one of `tags`; the caller checks the rest. */
		tagged<T extends string>(
			value: unknown,
			at: string,
			field: string,
			tags: readonly T[],
		): { tag: T; fields: Fields } {
			if (!isPlainObject(value)) return fail(at, "expected an object");
			const found = tags.find((t) => t === value[field]);
			if (found === undefined)
				return fail(at, `expected ${field} to be one of ${tags.join(", ")}`);
			return { tag: found, fields: value };
		},
		sameKeys,
	};
}

/** Checks app values before they reach a kernel. Throws KernelInputError. */
export const inputCodec = makeCodec(KernelInputError);
/** Checks a kernel's answer before it becomes an approval. Throws KernelOutputError. */
export const outputCodec = makeCodec(KernelOutputError);
