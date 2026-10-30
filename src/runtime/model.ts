// Compares a TypeScript implementation with a proven Lean model. Generated
// `check…AgainstModel` functions call this; it compiles the kernel's Lean
// sources, runs the generated Oracle.lean, and feeds both sides the same
// inputs. A clean run means the implementation agreed with the model on
// those inputs: tested, not proved.

import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, toolchain } from "../backends/lean.ts";
import type { Outcome } from "./index.ts";

export interface CompareOptions<Input> {
	/** Inputs to try first, e.g. the edge cases your team signed off. */
	readonly cases?: readonly Input[];
	/** How many random inputs to add; default 200. */
	readonly random?: number;
	readonly seed?: number;
}

export interface Mismatch<Input> {
	readonly input: Input;
	readonly implementation: unknown;
	readonly model: unknown;
}

export interface ModelKernel<Input, Value, Refusal> {
	/** The kernel directory: holds the .lean sources and the generated Oracle.lean. */
	readonly kernelDir: URL;
	/** The Lean module defining the entry, e.g. "Kernel". */
	readonly module: string;
	readonly parse: (value: unknown, at: string) => Input;
	readonly answer: (out: unknown) => Outcome<Value, Refusal>;
	readonly arbitrary: (r: () => number) => Input;
}

export class ModelError extends Error {
	override name = "ModelError";
}

/** A small seeded generator (mulberry32), so failures can be replayed. */
export function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pick = <T>(r: () => number, options: readonly T[]): T =>
	options[Math.floor(r() * options.length)] as T;

/** Random values that favour edges: 0, 1, small numbers and a few large ones. */
export const arbitrary = {
	nat: (r: () => number): number =>
		r() < 0.7 ? Math.floor(r() * 12) : pick(r, [100, 1_000, 65_535, 1_000_000]),
	bool: (r: () => number): boolean => r() < 0.5,
	string: (r: () => number): string => pick(r, ["", "a", "b", "ab", "Z9"]),
	list: <T>(r: () => number, item: () => T): T[] =>
		Array.from({ length: Math.floor(r() * 4) }, item),
	maybe: <T>(r: () => number, item: () => T): T | null =>
		r() < 0.3 ? null : item(),
	oneOf: <T>(r: () => number, options: readonly T[]): T => pick(r, options),
};

function sources(dir: string, sub = ""): [string, string][] {
	return readdirSync(path.join(dir, sub), { withFileTypes: true }).flatMap(
		(entry) => {
			const rel = path.posix.join(sub, entry.name);
			if (
				entry.isDirectory() &&
				entry.name !== "dist" &&
				!entry.name.startsWith(".")
			)
				return sources(dir, rel);
			return entry.isFile() && entry.name.endsWith(".lean")
				? [[rel, readFileSync(path.join(dir, rel), "utf8")] as [string, string]]
				: [];
		},
	);
}

// Field order is not meaningful, so compare with keys sorted.
const canonical = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(canonical)
		: value !== null && typeof value === "object"
			? Object.fromEntries(
					Object.entries(value)
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
						.map(([k, v]) => [k, canonical(v)]),
				)
			: value;
const same = (a: unknown, b: unknown) =>
	JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function compareWithModel<Input, Value, Refusal>(
	kernel: ModelKernel<Input, Value, Refusal>,
	implementation: (input: Input) => Outcome<Value, Refusal>,
	options: CompareOptions<Input> = {},
): Mismatch<Input>[] {
	const r = seeded(options.seed ?? 1);
	const inputs = [
		...(options.cases ?? []),
		...Array.from({ length: options.random ?? 200 }, () => kernel.arbitrary(r)),
	].map((input, index) => kernel.parse(input, `input[${index}]`));
	const tools = toolchain();
	if (typeof tools === "string") throw new ModelError(tools);
	const work = mkdtempSync(path.join(os.tmpdir(), "prove-model-"));
	try {
		for (const [file, body] of sources(fileURLToPath(kernel.kernelDir))) {
			mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
			writeFileSync(path.join(work, file), body);
		}
		const built = build(tools, work, kernel.module, false);
		if (!("ok" in built))
			throw new ModelError(`the Lean model does not build:\n${built.output}`);
		const run = spawnSync(tools.lean, ["--run", "Oracle.lean"], {
			cwd: work,
			input: `${inputs.map((input) => JSON.stringify(input)).join("\n")}\n`,
			encoding: "utf8",
			timeout: 300_000,
			maxBuffer: 64 << 20,
			env: {
				LEAN_PATH: work,
				HOME: work,
				PATH: `${path.dirname(tools.lean)}:/usr/bin:/bin`,
			},
		});
		if (run.status !== 0)
			throw new ModelError(
				`the Lean model did not run:\n${run.stdout}${run.stderr}`,
			);
		const answers = run.stdout.trimEnd().split("\n");
		if (answers.length !== inputs.length)
			throw new ModelError(
				`the Lean model answered ${answers.length} of ${inputs.length} inputs`,
			);
		const mismatches: Mismatch<Input>[] = [];
		for (const [index, input] of inputs.entries()) {
			const model = kernel.answer(JSON.parse(answers[index] as string));
			let mine: unknown;
			try {
				mine = implementation(input);
			} catch (error) {
				mine = {
					threw: error instanceof Error ? error.message : String(error),
				};
			}
			if (!same(mine, model))
				mismatches.push({ input, implementation: mine, model });
		}
		return mismatches;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
