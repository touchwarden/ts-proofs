// Generator coverage for the value types the six examples don't use. These
// are small fixtures, not use cases: each exists to push one part of the
// codec. See examples/ and specs/bend-kernel-e2e-tests.html for the real
// integrations.
//   1. floats and optional values (F32, Maybe, NaN)
//   2. lists, string identity, size bounds
//   3. your own generic types, U32 width and overflow

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { decider, expectTypeErrors, generated, get } from "./helpers.ts";

let tmp = "";
const dirs = { coldchain: "", signoff: "", quota: "" };

before(() => {
	tmp = mkdtempSync(path.join(os.tmpdir(), "touchwarden-codec-"));
	dirs.coldchain = generated(tmp, "coldchain", "accept");
	dirs.signoff = generated(tmp, "signoff", "release");
	dirs.quota = generated(tmp, "quota", "grant");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const importOf = (name: string) =>
	`import { ${name} } from "./${name}/${name}.gen.ts";`;

// 1 ===========================================================================
describe("1. floats and optional values (cold-chain fixture)", () => {
	const reading = (temp: unknown, note: unknown = null) => ({
		temp,
		min: 2,
		max: 8,
		probe: "P-1",
		note,
	});

	it("decides in range, too warm and too cold, inclusive at both ends", async () => {
		const { decide } = await decider(dirs.coldchain, "accept");
		assert.deepEqual(get(decide(reading(4)), "approval", "result"), {
			temp: 4,
			probe: "P-1",
			note: null,
		});
		assert.deepEqual(decide(reading(8.5)), {
			ok: false,
			result: { kind: "TooWarm", temp: 8.5 },
		});
		assert.deepEqual(decide(reading(1.5)), {
			ok: false,
			result: { kind: "TooCold", temp: 1.5 },
		});
		assert.equal(get(decide(reading(8)), "ok"), true);
		assert.equal(get(decide(reading(2)), "ok"), true);
	});

	it("NaN passes the raw proven kernel but never reaches it through the generated check", async () => {
		const { decide, rawEntry } = await decider(dirs.coldchain, "accept");
		// Every comparison with NaN is false, so neither "too warm" nor "too cold" fires.
		assert.deepEqual(
			rawEntry({ $: "Reading", ...reading(Number.NaN), note: { $: "None" } }),
			{
				$: "Done",
				value: {
					$: "Accepted",
					temp: Number.NaN,
					probe: "P-1",
					note: { $: "None" },
				},
			},
		);
		for (const bad of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			1e39,
			"4",
			null,
		])
			assert.throws(
				() => decide(reading(bad)),
				{ name: "KernelInputError" },
				String(bad),
			);
	});

	it("rounds to 32 bits, so the approval records what the kernel compared", async () => {
		const { decide } = await decider(dirs.coldchain, "accept");
		const r = decide(reading(4.1));
		assert.notEqual(Math.fround(4.1), 4.1);
		assert.equal(get(r, "approval", "result", "temp"), Math.fround(4.1));
		// The approval records the checked value the kernel saw, not the caller's 4.1.
		assert.equal(get(r, "approval", "input", "temp"), Math.fround(4.1));
	});

	it("treats null as no note, refuses undefined, keeps any Unicode text", async () => {
		const { decide, gen } = await decider(dirs.coldchain, "accept");
		// The note goes into Bend as Some{…} and comes back out of the approval.
		assert.equal(
			get(decide(reading(4, "héllo ✓ 冷")), "approval", "result", "note"),
			"héllo ✓ 冷",
		);
		assert.throws(() => decide({ ...reading(4), note: undefined }), {
			name: "KernelInputError",
		});
		const { note: _, ...missing } = reading(4);
		assert.throws(() => decide(missing), { name: "KernelInputError" });
		assert.throws(() => decide({ ...reading(4), probe: "x".repeat(65_537) }), {
			name: "KernelInputError",
		});
		const validate = get(gen, "acceptInput", "~standard", "validate");
		assert.equal(typeof validate, "function");
		if (typeof validate === "function")
			assert.match(
				JSON.stringify(validate(reading(Number.NaN))),
				/input\.temp: expected a finite number/,
			);
	});

	it("rejects the same mistakes at compile time", () => {
		expectTypeErrors(
			tmp,
			"coldchain-types.ts",
			[importOf("coldchain")],
			[
				[
					'coldchain.accept({ temp: 4, min: 2, max: 8, probe: "P", note: undefined });',
					"TS2322",
				],
				[
					'coldchain.accept({ temp: "4", min: 2, max: 8, probe: "P", note: null });',
					"TS2322",
				],
				[
					'coldchain.accept({ temp: 4, min: 2, max: 8, probe: "P" });',
					"TS2741",
				],
			],
		);
	});
});

// 2 ===========================================================================
describe("2. lists, string identity and size bounds (sign-off fixture)", () => {
	const request = (reviewers: unknown[], required = 2, author = "ana") => ({
		author,
		reviewers,
		required,
	});

	it("counts distinct reviewers, never the author, and refuses too few", async () => {
		const { decide } = await decider(dirs.signoff, "release");
		// The release lists who was asked: a Bend list decoded back to an array.
		assert.deepEqual(
			get(decide(request(["bo", "ana", "cy"])), "approval", "result"),
			{ approvals: 2, reviewers: ["bo", "ana", "cy"] },
		);
		// One refusal constructor with fields becomes a plain record.
		assert.deepEqual(decide(request(["bo", "bo"])), {
			ok: false,
			result: { have: 1, need: 2 },
		});
		assert.deepEqual(decide(request(["ana", "ana"])), {
			ok: false,
			result: { have: 0, need: 2 },
		});
		assert.deepEqual(decide(request([], 0)), {
			ok: true,
			approval: get(decide(request([], 0)), "approval"),
		});
	});

	it("compares exact code points: the app must normalise names first", async () => {
		const { decide } = await decider(dirs.signoff, "release");
		// "José" composed and decomposed, and a case change, are different strings to the kernel.
		assert.equal(get(decide(request(["josé", "josé"])), "ok"), true);
		assert.equal(get(decide(request(["Bo", "bo"])), "ok"), true);
		assert.equal(
			get(decide(request(["josé", "josé"].map((n) => n.normalize()))), "ok"),
			false,
		);
	});

	it("bounds list size before the kernel runs, and handles hundreds of items", async () => {
		const { decide } = await decider(dirs.signoff, "release");
		const started = performance.now();
		assert.throws(
			() => decide(request(Array.from({ length: 10_001 }, (_, i) => `r${i}`))),
			{ name: "KernelInputError", message: /at most 10000 items/ },
		);
		assert.ok(performance.now() - started < 1_000, "rejected before any work");
		const many = Array.from({ length: 300 }, (_, i) => `r${i}`);
		assert.deepEqual(get(decide(request(many, 300)), "approval", "result"), {
			approvals: 300,
			reviewers: many,
		});
	});

	it("names the failing item and freezes the approved list", async () => {
		const { decide } = await decider(dirs.signoff, "release");
		assert.throws(() => decide(request(["bo", 42])), {
			name: "KernelInputError",
			message: /input\.reviewers\[1\]: expected a string/,
		});
		const reviewers = get(
			decide(request(["bo", "cy"])),
			"approval",
			"input",
			"reviewers",
		);
		assert.ok(Array.isArray(reviewers));
		assert.throws(() => reviewers.push("eve"), TypeError);
	});

	it("types lists as readonly arrays", () => {
		expectTypeErrors(
			tmp,
			"signoff-types.ts",
			[importOf("signoff")],
			[
				[
					'signoff.release({ author: "a", reviewers: "bo", required: 1 });',
					"TS2322",
				],
				[
					'const r = signoff.release({ author: "a", reviewers: ["bo"], required: 1 }); if (r.ok) r.approval.input.reviewers.push("x");',
					"TS2339",
				],
			],
		);
	});
});

// 3 ===========================================================================
describe("3. generic types and 32-bit counters (quota fixture)", () => {
	const limit = (resource: string, max: number) => ({ resource, max });
	const request = (
		limits: unknown[],
		resource: string,
		used: unknown,
		adding: unknown,
	) => ({ limits, resource, used, adding });

	it("looks up a generic Limit<Resource> and decodes the result's enum", async () => {
		const { decide } = await decider(dirs.quota, "grant");
		assert.deepEqual(
			get(
				decide(request([limit("Seats", 10)], "Seats", 3, 2)),
				"approval",
				"result",
			),
			{ resource: "Seats", total: 5 },
		);
		assert.deepEqual(decide(request([limit("Seats", 10)], "Storage", 0, 1)), {
			ok: false,
			result: { kind: "NoLimit" },
		});
		// The first limit listed for a resource wins.
		assert.deepEqual(
			decide(request([limit("Seats", 5), limit("Seats", 100)], "Seats", 3, 3)),
			{ ok: false, result: { kind: "OverLimit", total: 6, max: 5 } },
		);
	});

	it("can't be tricked by U32 wrap-around, which a naive kernel would allow", async () => {
		const { decide, raw } = await decider(dirs.quota, "grant");
		const top = 2 ** 32 - 1;
		const naive = get(raw, "default", "naive_total");
		assert.equal(typeof naive, "function");
		if (typeof naive === "function") assert.equal(naive(top, 1), 0);
		assert.deepEqual(decide(request([limit("Calls", top)], "Calls", top, 1)), {
			ok: false,
			result: { kind: "OverLimit", total: 2 ** 32, max: top },
		});
		assert.equal(
			get(decide(request([limit("Calls", top)], "Calls", top, 0)), "ok"),
			true,
		);
	});

	it("checks U32 range and reports paths inside generic lists", async () => {
		const { decide } = await decider(dirs.quota, "grant");
		for (const bad of [2 ** 32, -1, 1.5, "1"])
			assert.throws(
				() => decide(request([limit("Seats", 10)], "Seats", bad, 0)),
				{ name: "KernelInputError" },
				String(bad),
			);
		assert.throws(
			() =>
				decide(request([limit("Seats", 1), limit("seats", 1)], "Seats", 0, 0)),
			{
				message:
					/input\.limits\[1\]\.resource: expected one of Seats, Storage, Calls/,
			},
		);
	});

	it("types generics and hides the kernel's helpers", () => {
		expectTypeErrors(
			tmp,
			"quota-types.ts",
			[
				importOf("quota"),
				'import type { Limit, Resource } from "./quota/quota.gen.ts";',
				'import raw from "./quota/quota.mjs";',
			],
			[
				[
					'const l: Limit<Resource> = { resource: "Seat", max: 1 }; void l;',
					"TS2820",
				],
				[
					'quota.grant({ limits: [{ resource: "Seats", max: 1, extra: 1 }], resource: "Seats", used: 0, adding: 0 });',
					"TS2353",
				],
				["raw.naive_total(1, 2);", "TS2339"],
			],
		);
	});
});
