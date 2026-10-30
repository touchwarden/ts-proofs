// The refunds example, attacked the ways the README describes: each change
// below is a PR against a copy of the example, judged by `prove check`.
// Needs `pnpm build` first (the example imports @touchwarden/prove).
// Lean proofs need Lean (PROVE_LEAN or lean on PATH); without it, and
// without Lasm for the example's generated dist/, those tests skip.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { leanCommand } from "../src/backends/lean.ts";
import { checkRepo, type Report, renderText } from "../src/check.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLE = path.join(ROOT, "examples/refunds");
const [leanCmd, leanArgs] = leanCommand();
const noLean = spawnSync(leanCmd, [...leanArgs, "--version"]).error
	? "Lean is not installed (set PROVE_LEAN or put lean on PATH)"
	: false;

// The line in src/refund.ts the attacks edit, kept as source text.
const REFUSED =
	"\tif (!decision.ok) return `refused: $" + "{decision.result}`;";

let repo = "";
const git = (...args: string[]) =>
	execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
const commit = (message: string) => {
	git("add", "-A");
	git(
		"-c",
		"user.name=Example",
		"-c",
		"user.email=example@invalid",
		"commit",
		"-qm",
		message,
	);
};
const edit = (file: string, from: string, to: string) => {
	const target = path.join(repo, file);
	const body = readFileSync(target, "utf8");
	assert.ok(body.includes(from), `${file} should contain ${from}`);
	writeFileSync(target, body.replace(from, to));
};
// Each attack starts from the clean base.
const attempt = (name: string, change: () => void) => {
	git("checkout", "-q", "main");
	git("checkout", "-q", "-B", name);
	change();
	commit(name);
};
const rule = (report: Report, id: string) => {
	const found = report.rules.find((r) => r.id === id);
	assert.ok(found, `no rule ${id}`);
	return found;
};

before(() => {
	assert.ok(
		existsSync(path.join(ROOT, "dist/runtime/index.js")),
		"run pnpm build first",
	);
	repo = mkdtempSync(path.join(os.tmpdir(), "prove-refunds-"));
	cpSync(EXAMPLE, repo, {
		recursive: true,
		filter: (source) =>
			!/(?:^|\/)(?:dist|\.lake|node_modules)(?:\/|$)/.test(source),
	});
	// The example imports @touchwarden/prove; point it at this checkout.
	mkdirSync(path.join(repo, "node_modules/@touchwarden"), { recursive: true });
	symlinkSync(ROOT, path.join(repo, "node_modules/@touchwarden/prove"));
	symlinkSync(
		path.join(ROOT, "node_modules/@types"),
		path.join(repo, "node_modules/@types"),
	);
	writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
	git("init", "-q", "-b", "main");
	commit("base");
});
after(() => rmSync(repo, { recursive: true, force: true }));

test("an honest change passes the gate; unproved Lean is reported as incomplete", () => {
	attempt("honest", () => edit("src/refund.ts", "refused: ", "not refunded: "));
	const report = checkRepo(repo, "main");
	const refund = rule(report, "refund-within-captured");
	assert.equal(
		refund.gate?.verdict,
		"pass",
		refund.gate?.problems.join("\n") ?? "",
	);
	assert.equal(refund.proof.verdict, "skipped");
	assert.match(refund.proof.detail, /--allow-repo-execution/);
	assert.equal(report.verdict, "incomplete", renderText(report));
});

test("a forged approval is caught by the gate", () => {
	attempt("forge", () =>
		edit(
			"src/refund.ts",
			REFUSED,
			'	if (!decision.ok) {\n		recordRefund(paymentId, { input: { captured: 0, refunded: 0, amount }, result: { amount } } as RefundsApproved);\n		return "refunded anyway";\n	}',
		),
	);
	edit(
		"src/refund.ts",
		'import { refunds } from "../kernels/lasm/refunds/refunds.gen.ts";',
		'import { refunds, type RefundsApproved } from "../kernels/lasm/refunds/refunds.gen.ts";',
	);
	commit("forge import");
	const report = checkRepo(repo, "main");
	const refund = rule(report, "refund-within-captured");
	assert.equal(refund.gate?.verdict, "fail");
	assert.match(
		refund.gate?.problems.join("\n") ?? "",
		/forges a proof|asserted value/,
	);
	assert.equal(report.verdict, "fail");
});

test("skipping the kernel and writing to the ledger directly is caught", () => {
	attempt("skip", () =>
		edit(
			"src/refund.ts",
			REFUSED,
			'	if (!decision.ok) {\n		ledger.insertRefund(paymentId, amount);\n		return "refunded anyway";\n	}',
		),
	);
	const refund = rule(checkRepo(repo, "main"), "refund-within-captured");
	assert.equal(refund.gate?.verdict, "fail");
	assert.match(refund.gate?.problems.join("\n") ?? "", /ledger\.insertRefund/);
});

test("a second decider that would issue approvals is caught", () => {
	attempt("mint", () =>
		writeFileSync(
			path.join(repo, "src/mint.ts"),
			'import * as tw from "@touchwarden/prove/runtime";\nexport const yes = tw.defineDecider("refunds.decide", (v) => v, () => ({ done: true, value: { amount: 1 } }));\n',
		),
	);
	const refund = rule(checkRepo(repo, "main"), "refund-within-captured");
	assert.equal(refund.gate?.verdict, "fail");
	assert.match(
		refund.gate?.problems.join("\n") ?? "",
		/Deciders may only be made/,
	);
});

test("a kernel bug fails the proof, even when the PR also weakens the law", {
	skip: noLean,
	timeout: 600_000,
}, () => {
	attempt("kernel-bug", () => {
		edit(
			"kernels/lasm/refunds/Kernel.lean",
			"r.refunded + r.amount ≤ r.captured",
			"r.refunded ≤ r.captured",
		);
		edit(
			"kernels/lasm/refunds/Laws.lean",
			"Kernel.decide r = .ok a → r.refunded + a.amount ≤ r.captured",
			"Kernel.decide r = .ok a → r.refunded ≤ r.captured",
		);
	});
	const report = checkRepo(repo, "main", { allowRepoExecution: true });
	const refund = rule(report, "refund-within-captured");
	assert.equal(refund.proof.verdict, "failed", refund.proof.output);
	assert.ok(refund.review.includes("kernels/lasm/refunds/Laws.lean"));
	assert.equal(report.verdict, "fail");
});

test("with consent, the unchanged kernel is proven against base", {
	skip: noLean,
	timeout: 600_000,
}, () => {
	attempt("consented", () =>
		edit("src/refund.ts", "refused: ", "not refunded: "),
	);
	const report = checkRepo(repo, "main", { allowRepoExecution: true });
	const refund = rule(report, "refund-within-captured");
	assert.equal(refund.proof.verdict, "proven", refund.proof.output);
	assert.equal(
		rule(report, "refund-within-captured-model").proof.verdict,
		"model-proven",
	);
});

test("pull_request_target never runs Lean proofs, even with consent", () => {
	attempt("target", () => edit("src/refund.ts", "refused: ", "not refunded: "));
	const report = checkRepo(repo, "main", {
		allowRepoExecution: true,
		env: { GITHUB_EVENT_NAME: "pull_request_target" },
	});
	assert.match(
		rule(report, "refund-within-captured").proof.detail,
		/pull_request_target/,
	);
});
