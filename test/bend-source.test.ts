import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type KernelSource,
	parseKernelSource,
	probeSource,
} from "../src/generate/bend-source.ts";

const FIXTURES = fileURLToPath(new URL("fixtures/", import.meta.url));
const orders = readFileSync(path.join(FIXTURES, "orders/main.bend"), "utf8");
const wallet = readFileSync(path.join(FIXTURES, "wallet/main.bend"), "utf8");

test("reads Data types into TypeScript shapes and the entry signature", () => {
	const k = parseKernelSource(orders, "step");
	assert.deepEqual(
		[...k.types.values()].map((t) => [t.name, t.shape]),
		[
			["Status", "enum"],
			["Action", "union"],
			["Request", "record"],
			["Step", "record"],
			["Refusal", "union"],
		],
	);
	assert.deepEqual(k.types.get("Action")?.constructors[2], {
		name: "Refund",
		fields: [
			{ name: "amount", type: { kind: "Nat" } },
			{ name: "restock", type: { kind: "Bool" } },
		],
	});
	assert.deepEqual(k.entry, {
		name: "step",
		param: { name: "r", type: { kind: "Data", name: "Request", args: [] } },
		quantities: ["&1", "&1"],
		refusal: { kind: "Data", name: "Refusal", args: [] },
		value: { kind: "Data", name: "Step", args: [] },
	});
});

test("names what it does not support", () => {
	const cases: [string, string, RegExp][] = [
		[
			wallet.replace("type Payout is Data:", "type Payout<A> is Data:"),
			"withdraw",
			/type parameters must be written -A: Data/,
		],
		[
			wallet.replace("Payout{amount: Nat}", "Payout{amount: F64}"),
			"withdraw",
			/type F64 is not supported/,
		],
		[
			wallet.replace("Payout{amount: Nat}", "Payout{amount: List<&1, Nat>}"),
			"withdraw",
			/write List<&2, T> or \+List<T>/,
		],
		[
			wallet.replace(
				"Payout{amount: Nat}",
				"Payout{amount: Maybe<&2, Maybe<&2, Nat>>}",
			),
			"withdraw",
			/can't be told apart/,
		],
		[
			wallet.replace("Payout{amount: Nat}", "Payout{amount: Request<Nat>}"),
			"withdraw",
			/Request takes 0 type parameter/,
		],
		[
			wallet.replace(
				"def withdraw(+r: Request)",
				"def withdraw(+r: Request, x: Nat)",
			),
			"withdraw",
			/exactly one input/,
		],
		[
			wallet.replace(
				/-> Result<&1, &1, Refusal, Payout>:\n {2}match r:/,
				"-> Payout:\n  match r:",
			),
			"withdraw",
			/must return Bend's Result/,
		],
		[wallet, "deposit", /no def deposit/],
		[
			orders.replace(
				"Refund{amount: Nat, restock: Bool}",
				"Refund{amount: Nat, kind: Bool}",
			),
			"step",
			/field named "kind"/,
		],
		[
			orders.replace("  Ship{}\n", "  Ship{}\n  Pay{}\n"),
			"step",
			/Pay is declared twice/,
		],
	];
	for (const [source, entry, message] of cases)
		assert.throws(
			() => parseKernelSource(source, entry),
			message,
			String(message),
		);
});

test("Bend rejects a probe built from a wrong reading of main.bend", () => {
	const [cmd = "bend", ...prefix] = (
		process.env.PROVE_BEND ||
		process.env.TOUCHWARDEN_BEND ||
		"bend"
	).split(/\s+/);
	const right = parseKernelSource(orders, "step");
	const action = right.types.get("Action");
	assert.ok(action);
	// A reader that missed Ship, and one that thinks restock is a Nat.
	const wrong: KernelSource[] = [
		{
			...right,
			types: new Map([
				...right.types,
				[
					"Action",
					{
						...action,
						constructors: action.constructors.filter((c) => c.name !== "Ship"),
					},
				],
			]),
		},
		{
			...right,
			types: new Map([
				...right.types,
				[
					"Action",
					{
						...action,
						constructors: action.constructors.map((c) =>
							c.name === "Refund"
								? {
										...c,
										fields: c.fields.map((f) => ({
											...f,
											type: { kind: "Nat" } as const,
										})),
									}
								: c,
						),
					},
				],
			]),
		},
	];
	const dir = mkdtempSync(path.join(os.tmpdir(), "touchwarden-probe-"));
	try {
		copyFileSync(
			path.join(FIXTURES, "orders/main.bend"),
			path.join(dir, "main.bend"),
		);
		const check = (k: KernelSource) => {
			writeFileSync(path.join(dir, "probe.bend"), probeSource(k));
			const r = spawnSync(cmd, [...prefix, "probe.bend", "--check-only"], {
				cwd: dir,
				encoding: "utf8",
				env: {
					...process.env,
					BEND_HUB: "http://127.0.0.1:9",
					BEND_TELEMETRY: "0",
				},
			});
			return r.status === 0 && /^ALL PROOFS CHECK$/m.test(r.stdout);
		};
		assert.equal(check(right), true);
		for (const k of wrong) assert.equal(check(k), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
