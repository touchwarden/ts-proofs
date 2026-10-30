// End to end: real Bend checks the proofs and compiles the kernels, the real
// generator writes the modules, then the app side is exercised at runtime and
// under `tsc --strict`. Needs Bend: $PROVE_BEND, or `bend` on PATH.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
	cli,
	copyFixture,
	expectTypeErrors,
	fn,
	get,
	load as loadDir,
	RUNTIME,
	TSC,
	typecheck,
} from "./helpers.ts";

let tmp = "";
const kernelDir = (name: string, as = name) => copyFixture(tmp, name, as);
const load = (name: string) => loadDir(path.join(tmp, name));

before(() => {
	tmp = mkdtempSync(path.join(os.tmpdir(), "prove-e2e-"));
	for (const [name, entry] of [
		["wallet", "withdraw"],
		["orders", "step"],
	] as const) {
		const r = cli(kernelDir(name), "--entry", entry);
		assert.equal(r.status, 0, r.output);
	}
});

after(() => rmSync(tmp, { recursive: true, force: true }));

test("writes Bend's module, its types, the checked module and a manifest", () => {
	const dir = path.join(tmp, "wallet");
	const meta = JSON.parse(
		readFileSync(path.join(dir, "wallet.meta.json"), "utf8"),
	);
	const mjs = readFileSync(path.join(dir, "wallet.mjs"), "utf8");
	assert.equal(meta.rule, "wallet.withdraw");
	assert.match(meta.bend, /^\d+\.\d+\.\d+$/);
	assert.deepEqual(meta.laws, [
		"zero_is_refused",
		"example_within_limits",
		"over_balance_is_refused",
	]);
	assert.equal(
		meta.module.sha256,
		createHash("sha256").update(mjs).digest("hex"),
	);
	assert.match(
		mjs,
		/^export default \{/m,
		"the module is Bend's -o output, unwrapped",
	);
	assert.match(
		readFileSync(path.join(dir, "wallet.gen.ts"), "utf8"),
		new RegExp(`sha256 ${meta.module.sha256}`),
	);
	assert.match(
		readFileSync(path.join(dir, "wallet.d.mts"), "utf8"),
		/withdraw: \(input: unknown\) => unknown/,
	);
});

test("--check passes on fresh output and catches hand edits", () => {
	const dir = path.join(tmp, "wallet");
	const fresh = cli(dir, "--entry", "withdraw", "--check");
	assert.equal(fresh.status, 0, fresh.output);
	const edits: [string, string, string][] = [
		["wallet.mjs", "if (_ok_0) {", "if (true) {"],
		["wallet.gen.ts", "o.sameKeys(", "void ("],
	];
	for (const [file, from, to] of edits) {
		const target = path.join(dir, file);
		const original = readFileSync(target, "utf8");
		assert.ok(original.includes(from), `${file} has ${from}`);
		writeFileSync(target, original.replace(from, to));
		const stale = cli(dir, "--entry", "withdraw", "--check");
		writeFileSync(target, original);
		assert.equal(stale.status, 1, stale.output);
		assert.match(
			stale.output,
			new RegExp(`edited by hand: ${file.replaceAll(".", "\\.")}`),
		);
	}
});

test("wallet: decides through the compiled kernel and issues single-use approvals", async () => {
	const { gen, raw } = await load("wallet");
	const withdraw = fn(gen, "wallet", "withdraw");
	const consume = fn(gen, "wallet", "withdraw", "consume");
	const at = (amount: unknown) => ({
		balance: 100,
		amount,
		daily_used: 0,
		daily_limit: 50,
	});

	const yes = withdraw(at(40));
	assert.equal(get(yes, "ok"), true);
	assert.deepEqual(get(yes, "approval", "result"), { amount: 40 });
	assert.ok(Object.isFrozen(get(yes, "approval", "input")));
	assert.ok(Object.isFrozen(get(yes, "approval", "result")));
	assert.deepEqual(withdraw(at(60)), { ok: false, result: "OverLimit" });
	assert.deepEqual(withdraw(at(0)), { ok: false, result: "ZeroAmount" });
	assert.deepEqual(withdraw(at(101)), { ok: false, result: "OverLimit" });

	// What the checks are for: the raw compiled kernel pays out a negative amount.
	assert.deepEqual(
		fn(raw, "default", "withdraw")({ $: "Request", ...at(-5) }),
		{
			$: "Done",
			value: { $: "Payout", amount: -5 },
		},
	);
	for (const bad of [
		at(-5),
		at(1.5),
		at("40"),
		at(2 ** 48),
		{ ...at(40), admin: true },
		{ balance: 100 },
		null,
	])
		assert.throws(
			() => withdraw(bad),
			{ name: "KernelInputError" },
			JSON.stringify(bad),
		);

	// Changing the caller's object afterwards doesn't change what was approved.
	const input = at(30);
	const later = withdraw(input);
	input.amount = 49;
	assert.equal(get(later, "approval", "input", "amount"), 30);

	assert.deepEqual(get(consume(get(yes, "approval")), "result"), {
		amount: 40,
	});
	assert.throws(() => consume(get(yes, "approval")), {
		name: "ForgedApprovalError",
	});
	assert.throws(
		() => consume(JSON.parse(JSON.stringify(get(later, "approval")))),
		{ name: "ForgedApprovalError" },
	);

	const validate = fn(gen, "withdrawInput", "~standard", "validate");
	assert.deepEqual(validate(at(40)), { value: at(40) });
	assert.match(
		JSON.stringify(validate(at(-5))),
		/input\.amount: expected a whole number/,
	);
});

test("orders: enums, tagged unions, booleans and nested records cross both ways", async () => {
	const { gen } = await load("orders");
	const step = fn(gen, "orders", "step");
	const consume = fn(gen, "orders", "step", "consume");
	const withdraw = fn((await load("wallet")).gen, "wallet", "withdraw");
	const refund = (amount: number) => ({
		kind: "Refund",
		amount,
		restock: true,
	});

	const yes = step({ status: "Paid", action: refund(30), paid: 50 });
	assert.deepEqual(get(yes, "approval", "result"), {
		to: "Refunded",
		restock: true,
	});
	assert.deepEqual(step({ status: "Paid", action: refund(60), paid: 50 }), {
		ok: false,
		result: { kind: "OverPaid", paid: 50 },
	});
	assert.deepEqual(
		step({ status: "Refunded", action: { kind: "Pay" }, paid: 0 }),
		{
			ok: false,
			result: { kind: "NotAllowed" },
		},
	);
	assert.deepEqual(
		get(
			step({ status: "Cart", action: { kind: "Pay" }, paid: 0 }),
			"approval",
			"result",
		),
		{
			to: "Paid",
			restock: false,
		},
	);
	for (const bad of [
		{ status: "paid", action: { kind: "Pay" }, paid: 0 },
		{ status: "Paid", action: { kind: "Bogus" }, paid: 0 },
		{ status: "Paid", action: { kind: "Refund", amount: 1 }, paid: 5 },
		{
			status: "Paid",
			action: { kind: "Refund", amount: 1, restock: "yes" },
			paid: 5,
		},
		{ status: "Paid", action: { kind: "Ship", amount: 1 }, paid: 5 },
	])
		assert.throws(
			() => step(bad),
			{ name: "KernelInputError" },
			JSON.stringify(bad),
		);

	// An approval is only accepted by the decider that issued it.
	const paid = withdraw({
		balance: 10,
		amount: 5,
		daily_used: 0,
		daily_limit: 10,
	});
	assert.throws(() => consume(get(paid, "approval")), {
		name: "ForgedApprovalError",
	});
	assert.deepEqual(get(consume(get(yes, "approval")), "result"), {
		to: "Refunded",
		restock: true,
	});
});

test("app code typechecks; skipping or forging the decision does not", () => {
	assert.ok(existsSync(TSC), `missing ${TSC}; run pnpm install`);
	const imports = [
		`import type { Approved } from ${JSON.stringify(RUNTIME)};`,
		'import { wallet } from "./wallet/wallet.gen.ts";',
		'import { orders } from "./orders/orders.gen.ts";',
	];
	assert.equal(
		typecheck(
			tmp,
			"app.ts",
			[
				...imports,
				"export function payout(a: Approved<typeof wallet.withdraw>): number {",
				"\treturn wallet.withdraw.consume(a).result.amount;",
				"}",
				"const r = wallet.withdraw({ balance: 100, amount: 40, daily_used: 0, daily_limit: 50 });",
				'if (r.ok) payout(r.approval); else { const why: "ZeroAmount" | "OverLimit" = r.result; void why; }',
				'const s = orders.step({ status: "Paid", action: { kind: "Refund", amount: 1, restock: false }, paid: 5 });',
				'if (!s.ok && s.result.kind === "OverPaid") void s.result.paid;',
				"",
			].join("\n"),
		),
		"",
		"app code and generated modules typecheck",
	);
	// One attempt per line, with the error tsc must report for it.
	expectTypeErrors(
		tmp,
		"negatives.ts",
		[...imports, 'import { payout } from "./app.ts";'],
		[
			[
				"const fake: Approved<typeof wallet.withdraw> = { input: { balance: 1, amount: 1, daily_used: 0, daily_limit: 1 }, result: { amount: 1000000 } };",
				"TS2741",
			],
			[
				"payout({ balance: 1, amount: 1, daily_used: 0, daily_limit: 1 });",
				"TS2353",
			],
			[
				"wallet.withdraw({ balance: 1, amont: 1, daily_used: 0, daily_limit: 1 });",
				"TS2561",
			],
			[
				"const r = wallet.withdraw({ balance: 1, amount: 0, daily_used: 0, daily_limit: 1 }); if (!r.ok) payout(r.result);",
				"TS2345",
			],
			[
				"const ok = wallet.withdraw({ balance: 9, amount: 1, daily_used: 0, daily_limit: 9 }); if (ok.ok) ok.approval.result.amount = 4000;",
				"TS2540",
			],
			[
				'const s = orders.step({ status: "Cart", action: { kind: "Pay" }, paid: 0 }); if (s.ok) payout(s.approval);',
				"TS2345",
			],
			[
				'orders.step({ status: "cart", action: { kind: "Pay" }, paid: 0 });',
				"TS2820",
			],
		],
	);
});

test("refuses to generate when a proof fails, and writes nothing", () => {
	const dir = kernelDir("wallet", "broken");
	const main = path.join(dir, "main.bend");
	writeFileSync(
		main,
		readFileSync(main, "utf8").replace(
			"Bool.and(Nat.is_le(amount, balance), ",
			"Bool.and(True{}, ",
		),
	);
	const r = cli(dir, "--entry", "withdraw");
	assert.equal(r.status, 1);
	assert.match(r.output, /did not accept the proofs/);
	assert.match(r.output, /SOME PROOFS FAIL/);
	assert.equal(existsSync(path.join(dir, "broken.gen.ts")), false);
});

test("refuses kernels outside the supported subset, naming the problem", () => {
	const dir = kernelDir("wallet", "listy");
	const main = path.join(dir, "main.bend");
	writeFileSync(
		main,
		readFileSync(main, "utf8").replace(
			"Payout{amount: Nat}",
			"Payout{amount: Nat, notes: Map<String, Nat>}",
		),
	);
	const r = cli(dir, "--entry", "withdraw");
	assert.equal(r.status, 1);
	assert.match(r.output, /type Map is not supported here/);
});
