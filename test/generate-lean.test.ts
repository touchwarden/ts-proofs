// Generates the refund kernel's TypeScript from scratch copies, for both
// Lean backends, and uses what comes out. Needs Lean; the lasm test also
// needs Lasm (PROVE_LASM, or lasm on PATH: `pnpm test` puts the pinned
// devDependency there).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lasmCommand, leanCommand } from "../src/backends/lean.ts";
import { KernelBuildError } from "../src/generate/bend.ts";
import {
	generateLeanKernel,
	staleLeanFiles,
	writeLeanKernel,
} from "../src/generate/lean.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUNTIME = {
	core: path.join(ROOT, "src/runtime/index.ts"),
	lasm: path.join(ROOT, "src/runtime/lasm.ts"),
	model: path.join(ROOT, "src/runtime/model.ts"),
};
const available = ([cmd, args]: [string, string[]]) =>
	!spawnSync(cmd, [...args, "--version"]).error;
const noLean = available(leanCommand()) ? false : "Lean is not installed";
const noLasm =
	noLean || (available(lasmCommand()) ? false : "Lasm is not installed");

const tmp = mkdtempSync(path.join(os.tmpdir(), "prove-gen-lean-"));
// A started Lasm program keeps the process alive, as a server would.
after(() => {
	rmSync(tmp, { recursive: true, force: true });
	setImmediate(() => process.exit(process.exitCode ?? 0));
});

function copy(backend: "lean" | "lasm", as: string = backend): string {
	const dir = path.join(tmp, as, "refunds");
	cpSync(path.join(ROOT, "examples/refunds/kernels", backend, "refunds"), dir, {
		recursive: true,
		filter: (source) =>
			!/(?:^|\/)(?:dist|\.lake)(?:\/|$)|\.gen\.ts$|\.meta\.json$|(?:Main|Oracle)\.lean$/.test(
				source,
			),
	});
	return dir;
}

// Values from the generated modules are reached as unknown and checked.
async function load(file: string): Promise<Record<string, unknown>> {
	const module: unknown = await import(pathToFileURL(file).href);
	assert.ok(module !== null && typeof module === "object");
	return Object.fromEntries(Object.entries(module));
}
function call(fn: unknown, ...args: unknown[]): unknown {
	assert.equal(typeof fn, "function");
	return typeof fn === "function"
		? Reflect.apply(fn, undefined, args)
		: undefined;
}

test("plain Lean: types, a wrapped implementation, and a model check that finds an off-by-one", {
	skip: noLean,
	timeout: 600_000,
}, async () => {
	const dir = copy("lean");
	const generated = generateLeanKernel({
		dir,
		entry: "Kernel.decide",
		backend: "lean",
		runtime: RUNTIME,
	});
	writeLeanKernel(dir, generated);
	assert.deepEqual(staleLeanFiles(dir, generated), []);
	const gen = await load(path.join(dir, "refunds.gen.ts"));
	const exact = (
		r: { captured: number; refunded: number; amount: number },
		strict: boolean,
	) =>
		r.amount === 0
			? { done: false, error: "ZeroAmount" }
			: (
						strict
							? r.refunded + r.amount < r.captured
							: r.refunded + r.amount <= r.captured
					)
				? { done: true, value: { amount: r.amount } }
				: { done: false, error: "OverCaptured" };
	const good = call(
		gen.checkRefundsAgainstModel,
		(r: { captured: number; refunded: number; amount: number }) =>
			exact(r, false),
	);
	assert.deepEqual(good, []);
	const bad = call(
		gen.checkRefundsAgainstModel,
		(r: { captured: number; refunded: number; amount: number }) =>
			exact(r, true),
		{
			cases: [{ captured: 100, refunded: 40, amount: 60 }],
			random: 0,
		},
	);
	assert.ok(Array.isArray(bad) && bad.length === 1, JSON.stringify(bad));
	const decider = call(
		gen.implementRefunds,
		(r: { captured: number; refunded: number; amount: number }) =>
			exact(r, false),
	);
	assert.deepEqual(call(decider, { captured: 100, refunded: 40, amount: 0 }), {
		ok: false,
		result: "ZeroAmount",
	});
});

test("generation refuses a kernel whose proof does not hold", {
	skip: noLean,
	timeout: 600_000,
}, () => {
	const dir = copy("lean", "broken");
	const kernel = path.join(dir, "Kernel.lean");
	writeFileSync(
		kernel,
		readFileSync(kernel, "utf8").replace(
			"r.refunded + r.amount ≤ r.captured",
			"r.refunded ≤ r.captured",
		),
	);
	assert.throws(
		() =>
			generateLeanKernel({
				dir,
				entry: "Kernel.decide",
				backend: "lean",
				runtime: RUNTIME,
			}),
		(error: unknown) =>
			error instanceof KernelBuildError &&
			/did not accept the proofs/.test(error.message),
	);
});

test("Lasm: the generated decider runs the proven wasm and issues single-use approvals", {
	skip: noLasm,
	timeout: 600_000,
}, async () => {
	const dir = copy("lasm");
	const generated = generateLeanKernel({
		dir,
		entry: "Kernel.decide",
		backend: "lasm",
		runtime: RUNTIME,
	});
	writeLeanKernel(dir, generated);
	assert.deepEqual(staleLeanFiles(dir, generated), []);
	const gen = await load(path.join(dir, "refunds.gen.ts"));
	const refunds = gen.refunds;
	assert.ok(refunds !== null && typeof refunds === "object");
	const decide: unknown = Reflect.get(refunds, "decide");
	const approved: unknown = await call(decide, {
		captured: 100,
		refunded: 40,
		amount: 60,
	});
	assert.deepEqual(approved, {
		ok: true,
		approval: {
			input: { captured: 100, refunded: 40, amount: 60 },
			result: { amount: 60 },
		},
	});
	assert.deepEqual(
		await call(decide, { captured: 100, refunded: 40, amount: 61 }),
		{ ok: false, result: "OverCaptured" },
	);
	const approval: unknown = Reflect.get(Object(approved), "approval");
	const consume: unknown = Reflect.get(Object(decide), "consume");
	call(consume, approval);
	assert.throws(() => call(consume, approval), /already used/);
	await assert.rejects(
		Promise.resolve(call(decide, { captured: -1, refunded: 0, amount: 1 })),
		/whole number/,
	);
});
