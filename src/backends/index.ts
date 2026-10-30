import type { BackendId, ProofBackend } from "./backend.ts";
import { bend } from "./bend.ts";
import { lasm, lean } from "./lean.ts";

export type {
	BackendId,
	KernelJob,
	KernelRun,
	ProofBackend,
} from "./backend.ts";
export { bend, bendCommand } from "./bend.ts";
export { lasm, lasmCommand, lean, leanCommand } from "./lean.ts";

export const backends: Record<BackendId, ProofBackend> = { bend, lean, lasm };

export function isBackendId(value: unknown): value is BackendId {
	return typeof value === "string" && Object.hasOwn(backends, value);
}
