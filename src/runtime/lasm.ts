// Starts a Lasm build of a generated Main.lean and hands back the kernel's
// decide function. The program publishes that function with Lasm's
// `exportDefault` (globalThis.__lasmDefaultExport) and then waits for calls,
// so it starts once per process and every decision is one call into wasm.
//
// The running program keeps Node's event loop alive, like a server does.
// Scripts and tests that should end on their own call process.exit.

export class LasmLoadError extends Error {
	override name = "LasmLoadError";
}

type KernelFunction = (input: unknown) => Promise<unknown>;

const KEY = "__lasmDefaultExport";
const started = new Map<string, Promise<KernelFunction>>();
// Programs publish through one global, so they start one at a time.
let queue: Promise<unknown> = Promise.resolve();

async function start(launcher: string, timeoutMs: number) {
	Reflect.deleteProperty(globalThis, KEY);
	await import(launcher);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const published: unknown = Reflect.get(globalThis, KEY);
		if (typeof published === "function") {
			Reflect.deleteProperty(globalThis, KEY);
			return (input: unknown): Promise<unknown> =>
				Promise.resolve(Reflect.apply(published, undefined, [input]));
		}
		if (Date.now() > deadline)
			throw new LasmLoadError(
				`${launcher} did not publish a kernel within ${timeoutMs} ms; was it built from a generated Main.lean?`,
			);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** The decide function of the Lasm program whose launcher is `launcher` (dist/main.mjs). */
export function lasmKernel(
	launcher: URL,
	timeoutMs = 30_000,
): Promise<KernelFunction> {
	const key = launcher.href;
	let kernel = started.get(key);
	if (!kernel) {
		kernel = queue.then(() => start(key, timeoutMs));
		queue = kernel.catch(() => undefined);
		started.set(key, kernel);
	}
	return kernel;
}
