// Shared by the end-to-end tests: run the real CLI, load generated modules,
// and typecheck snippets against them. Needs Bend: $PROVE_BEND, or `bend`
// on PATH.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const RUNTIME = path.join(ROOT, "src/runtime/index.ts");
const CLI = path.join(ROOT, "src/cli.ts");
export const TSC = path.join(ROOT, "node_modules/.bin/tsc");

export function bendCommand(): [string, ...string[]] {
	const [cmd = "bend", ...prefix] = (
		process.env.PROVE_BEND ||
		process.env.TOUCHWARDEN_BEND ||
		"bend"
	).split(/\s+/);
	return [cmd, ...prefix];
}

/** Runs `prove generate <args>` against this package's runtime. */
export function cli(...args: string[]) {
	const r = spawnSync(
		process.execPath,
		[CLI, "generate", ...args, "--runtime", RUNTIME],
		{ encoding: "utf8", timeout: 300_000 },
	);
	return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

export function copyFixture(tmp: string, name: string, as = name): string {
	const dir = path.join(tmp, as);
	cpSync(path.join(ROOT, "test/fixtures", name), dir, { recursive: true });
	return dir;
}

/** Copies a fixture and generates it; fails the test if generation fails. */
export function generated(tmp: string, name: string, entry: string): string {
	const dir = copyFixture(tmp, name);
	const r = cli(dir, "--entry", entry);
	assert.equal(r.status, 0, r.output);
	return dir;
}

// The generated modules only exist at runtime, so tests reach into them as
// unknown values and check every step.
export function get(value: unknown, ...keys: string[]): unknown {
	let current = value;
	for (const key of keys) {
		assert.ok(
			current !== null &&
				(typeof current === "object" || typeof current === "function"),
			`no ${key}`,
		);
		current = Reflect.get(current, key);
	}
	return current;
}

export function fn(value: unknown, ...keys: string[]) {
	const f = get(value, ...keys);
	assert.equal(typeof f, "function", keys.join("."));
	return (...args: unknown[]): unknown =>
		typeof f === "function" ? Reflect.apply(f, undefined, args) : undefined;
}

/** Imports a generated kernel module and Bend's raw module beside it. */
export async function load(
	dir: string,
	query = "",
): Promise<{ gen: unknown; raw: unknown }> {
	const name = path.basename(dir);
	return {
		gen: await import(
			`${pathToFileURL(path.join(dir, `${name}.gen.ts`)).href}${query}`
		),
		raw: await import(pathToFileURL(path.join(dir, `${name}.mjs`)).href),
	};
}

/** A kernel's decider and its consume, as plain functions. */
export async function decider(dir: string, entry: string, query = "") {
	const name = path.basename(dir);
	const { gen, raw } = await load(dir, query);
	return {
		gen,
		raw,
		decide: fn(gen, name, entry),
		consume: fn(gen, name, entry, "consume"),
		rawEntry: fn(raw, "default", entry),
	};
}

/**
 * Typechecks `lines` (one attempt per line after `header`) in `dir` under
 * the repo's strict settings. Returns tsc's output.
 */
export function typecheck(dir: string, file: string, source: string): string {
	writeFileSync(path.join(dir, file), source);
	const config = `${file}.tsconfig.json`;
	writeFileSync(
		path.join(dir, config),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				noUncheckedIndexedAccess: true,
				exactOptionalPropertyTypes: true,
				target: "ES2022",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				allowImportingTsExtensions: true,
				noEmit: true,
				skipLibCheck: true,
				types: ["node"],
				typeRoots: [path.join(ROOT, "node_modules/@types")],
			},
			files: [file],
		}),
	);
	const r = spawnSync(TSC, ["-p", config], { cwd: dir, encoding: "utf8" });
	return `${r.stdout}${r.stderr}`;
}

/**
 * Writes one attempt per line after `header` and checks tsc rejects each
 * with exactly the expected error, and reports nothing else.
 */
export function expectTypeErrors(
	dir: string,
	file: string,
	header: readonly string[],
	attempts: readonly (readonly [code: string, error: string])[],
): void {
	const errors = typecheck(
		dir,
		file,
		[...header, ...attempts.map(([code]) => `{ ${code} }`), ""].join("\n"),
	);
	const escaped = file.replaceAll(".", "\\.");
	for (const [index, [, code]] of attempts.entries()) {
		const line = header.length + index + 1;
		assert.match(
			errors,
			new RegExp(`${escaped}\\(${line},\\d+\\): error ${code}`),
			`line ${line} should fail with ${code}:\n${errors}`,
		);
	}
	assert.equal(errors.match(/error TS/g)?.length, attempts.length, errors);
}
