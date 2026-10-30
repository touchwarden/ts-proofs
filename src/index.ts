// Library entry: everything the CLI does, for tools that embed it.

export {
	type BackendId,
	backends,
	bend,
	bendCommand,
	isBackendId,
	type KernelJob,
	type KernelRun,
	lasm,
	lasmCommand,
	lean,
	leanCommand,
	type ProofBackend,
} from "./backends/index.ts";
export { proveLeanLaws } from "./backends/lean.ts";
export {
	type CheckOptions,
	checkRepo,
	type Report,
	type RuleReport,
	renderGithub,
	renderText,
} from "./check.ts";
export { type Config, parseConfig, type Rule } from "./config.ts";
export {
	configChain,
	type GateResult,
	type ProofGate,
	runProofGate,
} from "./gate.ts";
export {
	type GeneratedKernel,
	type GenerateOptions,
	generateKernel,
	KernelBuildError,
	staleFiles,
	writeKernel,
} from "./generate/bend.ts";
export {
	generateLeanKernel,
	type LeanGenerateOptions,
	type LeanRuntime,
	leanLaws,
	staleLeanFiles,
	writeLeanKernel,
} from "./generate/lean.ts";
