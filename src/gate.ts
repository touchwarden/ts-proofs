// Pinned TypeScript 5: the repo's own compiler is never loaded or run, and
// TypeScript 7 has no compiler API.
import { createRequire } from "node:module";
import path from "node:path";
import type TS from "typescript5";

// Loaded on first use: it costs ~150 ms, and most callers never run the gate.
let ts: typeof TS;
function loadTypeScript() {
	ts ??= createRequire(import.meta.url)("typescript5") as typeof TS;
}

// The gate: a trusted module (usually the generated one) makes a proof only
// when the kernel approves, and the sensitive call is only reachable with
// that proof. The idea is Ghosts of Departed Proofs (Noonan 2018), as in
// gdp-ts; this checks a TypeScript program for ways around it.
export interface ProofGate {
	// Directory holding the tsconfig.json of the code that must type-check.
	project: string;
	// Name of the proof type, e.g. RefundApproved.
	proof: string;
	// Files allowed to make proofs: the generated module, or a hand-written one.
	trusted: string[];
	// The sensitive call, and the one function allowed to make it.
	sink?: { call: string; only_in: string };
}

export interface GateResult {
	ok: boolean;
	stage?: "setup" | "typecheck" | "rule";
	problems: string[];
}

const MAX_PROBLEMS = 20;

// The gated project's tsconfig and every file it extends, repo-relative: an
// edit to any of them can loosen the checks the proofs depend on.
export function configChain(
	repo: string,
	gate: ProofGate,
	readFile?: (file: string) => string | undefined,
): string[] {
	loadTypeScript();
	const configPath = path.join(repo, gate.project, "tsconfig.json");
	const host = readFile
		? {
				...ts.sys,
				readFile,
				fileExists: (file: string) => readFile(file) !== undefined,
			}
		: ts.sys;
	const source = ts.readJsonConfigFile(configPath, host.readFile);
	ts.parseJsonSourceFileConfigFileContent(
		source,
		host,
		path.dirname(configPath),
		undefined,
		configPath,
	);
	return [configPath, ...(source.extendedSourceFiles ?? [])].map((file) =>
		path.relative(repo, file).split(path.sep).join("/"),
	);
}

export function runProofGate(repo: string, gate: ProofGate): GateResult {
	loadTypeScript();
	const projectDir = path.join(repo, gate.project);
	const configPath = path.join(projectDir, "tsconfig.json");
	const read = ts.readConfigFile(configPath, ts.sys.readFile);
	if (read.error)
		return { ok: false, stage: "setup", problems: [flatten(read.error)] };
	const parsed = ts.parseJsonConfigFileContent(
		read.config,
		ts.sys,
		projectDir,
		{ noEmit: true },
		configPath,
	);
	if (parsed.errors.length)
		return { ok: false, stage: "setup", problems: parsed.errors.map(flatten) };
	// Proof names are only distinct when function parameters are checked
	// contravariantly; without it a proof about one value fits any other.
	const { options } = parsed;
	if (!(options.strictFunctionTypes ?? options.strict))
		return {
			ok: false,
			stage: "setup",
			problems: [
				`${gate.project}/tsconfig.json must enable strictFunctionTypes (or strict); proofs are not checked without it.`,
			],
		};
	if (!(options.strictNullChecks ?? options.strict))
		return {
			ok: false,
			stage: "setup",
			problems: [
				`${gate.project}/tsconfig.json must enable strictNullChecks (or strict); nullable values cannot serve as proofs.`,
			],
		};
	const program = ts.createProgram({
		rootNames: parsed.fileNames,
		options: { ...options, noEmit: true },
	});
	const rel = (file: string) =>
		path.relative(repo, file).split(path.sep).join("/");
	// Unused-name errors (TS6133) usually follow from the real one, so list them last.
	const diagnostics = [...ts.getPreEmitDiagnostics(program)].sort(
		(a, b) => Number(a.code === 6133) - Number(b.code === 6133),
	);
	const typeErrors = diagnostics.map((d) => {
		if (!d.file || d.start === undefined) return flatten(d);
		const { line } = d.file.getLineAndCharacterOfPosition(d.start);
		return `${rel(d.file.fileName)}:${line + 1}: TS${d.code} ${flatten(d)}`;
	});

	const checker = program.getTypeChecker();
	const trusted = new Set(gate.trusted.map((t) => path.join(repo, t)));
	const problems: string[] = [];
	const report = (node: TS.Node, message: string) => {
		const file = node.getSourceFile();
		const { line } = file.getLineAndCharacterOfPosition(node.getStart());
		problems.push(`${rel(file.fileName)}:${line + 1}: ${message}`);
	};
	// The proof type's own symbol, and what it resolves to: a generated
	// `RefundsApproved = Approved<typeof refunds.decide>` is the runtime's
	// Approval<…> by the time a parameter is checked, so names alone miss it.
	const proofSymbols = new Set<TS.Symbol>();
	const proofTypes = new Set<TS.Type>();
	const mentionsProof = (type: TS.Type, depth = 0): boolean => {
		if (depth > 4) return false;
		if (
			proofTypes.has(type) ||
			type.aliasSymbol?.name === gate.proof ||
			type.getSymbol()?.name === gate.proof
		)
			return true;
		return type.isUnionOrIntersection()
			? type.types.some((t) => mentionsProof(t, depth + 1))
			: false;
	};
	// `any` and `never` (e.g. from `null!`) are both assignable to a proof type.
	const isAny = (type: TS.Type) =>
		(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Never)) !== 0;
	// An expression with a type error is typed `any` too; report the error, not that.
	const hasTypeError = (node: TS.Node) =>
		diagnostics.some(
			(d) =>
				d.file === node.getSourceFile() &&
				d.start !== undefined &&
				d.start >= node.getStart() &&
				d.start < node.getEnd(),
		);
	const declaredIn = (node: TS.CallExpression) => {
		const decl = checker.getResolvedSignature(node)?.getDeclaration();
		return decl ? path.normalize(decl.getSourceFile().fileName) : null;
	};
	const enclosingName = (node: TS.Node): string | null => {
		for (let n = node.parent; n; n = n.parent) {
			if (
				(ts.isMethodDeclaration(n) ||
					ts.isFunctionDeclaration(n) ||
					ts.isPropertyDeclaration(n)) &&
				n.name
			)
				return n.name.getText();
		}
		return null;
	};
	const requiresProof = (type: TS.Type, depth = 0): boolean => {
		if (
			depth > 8 ||
			type.flags &
				(ts.TypeFlags.Any |
					ts.TypeFlags.Unknown |
					ts.TypeFlags.Never |
					ts.TypeFlags.Null |
					ts.TypeFlags.Undefined |
					ts.TypeFlags.Void)
		)
			return false;
		// Every union alternative must require the real trusted proof; an intersection may add constraints.
		if (type.isUnion())
			return type.types.every((t) => requiresProof(t, depth + 1));
		if (type.isIntersection())
			return type.types.some((t) => requiresProof(t, depth + 1));
		return (
			proofTypes.has(type) ||
			[type.aliasSymbol, type.getSymbol()].some(
				(symbol) => symbol !== undefined && proofSymbols.has(symbol),
			)
		);
	};
	let sinkOwnerFound = false;
	const mintSymbols = new Set<TS.Symbol>();
	const mintReceivers = new Set<TS.Symbol>();
	const sinkSymbols = new Set<TS.Symbol>();
	const sinkReceivers = new Set<TS.Symbol>();
	const owners: TS.Node[] = [];
	const symbolAt = (node: TS.Node) => {
		let symbol = checker.getSymbolAtLocation(node);
		if (symbol && symbol.flags & ts.SymbolFlags.Alias)
			symbol = checker.getAliasedSymbol(symbol);
		return symbol;
	};
	const parts = gate.sink?.call.split(".") ?? [];
	const sinkMember = parts.at(-1);
	// Bind capabilities by declaration identity, not just spelling at a call site.
	// Otherwise an import alias, destructuring or a computed lookup escapes the check.
	for (const file of program.getSourceFiles()) {
		if (
			file.isDeclarationFile ||
			!file.fileName.startsWith(projectDir + path.sep)
		)
			continue;
		const collect = (node: TS.Node): void => {
			if (trusted.has(path.normalize(file.fileName))) {
				if (
					(ts.isInterfaceDeclaration(node) ||
						ts.isTypeAliasDeclaration(node) ||
						ts.isClassDeclaration(node)) &&
					node.name?.getText() === gate.proof
				) {
					const symbol = symbolAt(node.name);
					if (symbol) proofSymbols.add(symbol);
					const type = checker.getTypeAtLocation(node.name);
					// A proof that resolves to any, unknown or never proves nothing.
					if (
						!(
							type.flags &
							(ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
						)
					)
						proofTypes.add(type);
				}
				if (
					(ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
					node.name &&
					["prove", "defineProof"].includes(node.name.getText())
				) {
					const symbol = symbolAt(node.name);
					if (symbol) mintSymbols.add(symbol);
				}
				if (
					ts.isClassDeclaration(node) &&
					node.name &&
					node.members.some(
						(member) =>
							ts.isMethodDeclaration(member) &&
							member.name.getText() === "prove",
					)
				) {
					const symbol = symbolAt(node.name);
					if (symbol) mintReceivers.add(symbol);
				}
			}
			if (
				gate.sink &&
				(ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
				node.body &&
				node.name?.getText() === gate.sink.only_in
			)
				owners.push(node);
			if (
				(ts.isVariableDeclaration(node) ||
					ts.isPropertyDeclaration(node) ||
					ts.isFunctionDeclaration(node)) &&
				node.name &&
				node.name.getText() === parts[0]
			) {
				const root = symbolAt(node.name);
				if (root) {
					if (parts.length === 1) sinkSymbols.add(root);
					else {
						let type = checker.getTypeAtLocation(node.name);
						let member: TS.Symbol | undefined;
						for (const part of parts.slice(1)) {
							member = type.getProperty(part);
							if (!member) break;
							type = checker.getTypeOfSymbolAtLocation(member, node);
						}
						if (member) {
							sinkReceivers.add(root);
							sinkSymbols.add(member);
						}
					}
				}
			}
			ts.forEachChild(node, collect);
		};
		collect(file);
	}
	const inOwner = (node: TS.Node) => {
		for (let n: TS.Node | undefined = node; n; n = n.parent)
			if (owners.includes(n)) return true;
		return false;
	};
	const declarationName = (node: TS.Node) => {
		const p = node.parent;
		return (
			(ts.isVariableDeclaration(p) ||
				ts.isPropertyDeclaration(p) ||
				ts.isMethodDeclaration(p) ||
				ts.isFunctionDeclaration(p) ||
				ts.isParameter(p)) &&
			p.name === node
		);
	};

	for (const file of program.getSourceFiles()) {
		const name = path.normalize(file.fileName);
		if (
			file.isDeclarationFile ||
			name.includes(`${path.sep}node_modules${path.sep}`) ||
			!name.startsWith(projectDir + path.sep)
		)
			continue;
		const isTrusted = trusted.has(name);
		const visit = (node: TS.Node): void => {
			if (ts.isImportDeclaration(node) || ts.isTypeNode(node)) return;
			if (!isTrusted && ts.isIdentifier(node) && !declarationName(node)) {
				const symbol = symbolAt(node);
				if (symbol && (mintSymbols.has(symbol) || mintReceivers.has(symbol)))
					report(
						node,
						`Proof-minting capabilities may only be used in ${gate.trusted.join(", ")}; aliases and computed lookups cannot mint a ${gate.proof} proof.`,
					);
			}
			if (
				gate.sink &&
				ts.isIdentifier(node) &&
				!declarationName(node) &&
				!inOwner(node)
			) {
				const symbol = symbolAt(node);
				const receiver =
					ts.isPropertyAccessExpression(node.parent) &&
					node.parent.name === node
						? node.parent
						: node;
				const p = receiver.parent;
				const harmlessMember =
					ts.isPropertyAccessExpression(p) &&
					p.expression === receiver &&
					p.name.text !== sinkMember;
				if (
					symbol &&
					(sinkSymbols.has(symbol) ||
						(sinkReceivers.has(symbol) && !harmlessMember))
				)
					report(
						node,
						`${gate.sink.call} capability is referenced outside ${gate.sink.only_in}; aliases, destructuring and dynamic lookups cannot bypass the proof.`,
					);
			}
			if (
				gate.sink &&
				(ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
				node.name?.getText() === gate.sink.only_in
			) {
				sinkOwnerFound = true;
				// The gate is only a gate if its own signature demands the proof.
				if (
					!node.parameters.some(
						(p) =>
							!p.questionToken &&
							!p.initializer &&
							!p.dotDotDotToken &&
							requiresProof(checker.getTypeAtLocation(p)),
					)
				)
					report(
						node,
						`${gate.sink.only_in} no longer takes a ${gate.proof} parameter that is mandatory and excludes null, undefined and non-proof alternatives.`,
					);
			}
			if (ts.isCallExpression(node)) {
				const callee = node.expression.getText().replace(/\s+/g, "");
				if (
					gate.sink &&
					(callee === gate.sink.call ||
						callee.endsWith(`.${gate.sink.call}`)) &&
					enclosingName(node) !== gate.sink.only_in
				)
					report(
						node,
						`${gate.sink.call} is called outside ${gate.sink.only_in}, so the ${gate.proof} proof is skipped.`,
					);
				if (!isTrusted) {
					const from = declaredIn(node);
					const fromTrusted = from !== null && trusted.has(from);
					const method = ts.isPropertyAccessExpression(node.expression)
						? node.expression.name.text
						: ts.isIdentifier(node.expression)
							? node.expression.text
							: "";
					if (fromTrusted && (method === "defineProof" || method === "prove"))
						report(
							node,
							`Proofs may only be made in ${gate.trusted.join(", ")}.`,
						);
					// A decider issues approvals, so making one is minting: a second
					// decider with the same rule name and types would issue approvals
					// that type-check as the real ones. Generated modules make them.
					if (
						method === "defineDecider" ||
						method === "defineAsyncDecider" ||
						(fromTrusted && /^implement[A-Z]/.test(method))
					)
						report(
							node,
							`Deciders may only be made in ${gate.trusted.join(", ")}; one made elsewhere can issue ${gate.proof} approvals.`,
						);
				}
			}
			if (!isTrusted) {
				if (
					(ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
					mentionsProof(checker.getTypeFromTypeNode(node.type))
				)
					report(node, `Type assertion to ${gate.proof} forges a proof.`);
				// A proof-typed slot with no value (`let p!: T`, `declare const p: T`)
				// compiles and holds undefined at runtime.
				if (
					(ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
					node.type &&
					!node.initializer &&
					mentionsProof(checker.getTypeFromTypeNode(node.type))
				)
					report(
						node,
						`A ${gate.proof} is declared without a value, so it is not a real proof.`,
					);
				// Anything typed `any`, or asserted, satisfies a proof parameter.
				if (flowsSomewhere(node)) {
					const expected = checker.getContextualType(node);
					if (
						expected &&
						mentionsProof(expected) &&
						(ts.isAsExpression(node) ||
							ts.isTypeAssertionExpression(node) ||
							ts.isNonNullExpression(node) ||
							(isAny(checker.getTypeAtLocation(node)) && !hasTypeError(node)))
					)
						report(
							node,
							`An \`any\` or asserted value is used where a ${gate.proof} proof is required.`,
						);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(file);
	}
	if (gate.sink && !sinkOwnerFound)
		problems.push(`${gate.sink.only_in} was not found in ${gate.project}.`);
	if (gate.sink && owners.length !== 1)
		problems.push(
			`${gate.sink.only_in} must have exactly one implementation in ${gate.project}; found ${owners.length}.`,
		);
	if (gate.sink && !sinkSymbols.size)
		problems.push(
			`${gate.sink.call} could not be bound to a declaration; the gate fails closed.`,
		);
	// Rules run even when the code does not compile, and lead, because they
	// name the bypass while the type errors often only show its side effects.
	if (problems.length)
		return {
			ok: false,
			stage: "rule",
			problems: [...problems, ...typeErrors].slice(0, MAX_PROBLEMS),
		};
	return typeErrors.length
		? {
				ok: false,
				stage: "typecheck",
				problems: typeErrors.slice(0, MAX_PROBLEMS),
			}
		: { ok: true, problems: [] };
}

// Positions where a value is handed to something with an expected type:
// arguments, returns, initializers, assignments, object and array members.
function flowsSomewhere(node: TS.Node): node is TS.Expression {
	const p = node.parent;
	if (!p || !ts.isExpression(node)) return false;
	return (
		((ts.isCallExpression(p) || ts.isNewExpression(p)) &&
			(p.arguments?.includes(node) ?? false)) ||
		(ts.isReturnStatement(p) && p.expression === node) ||
		(ts.isArrowFunction(p) && p.body === node) ||
		(ts.isVariableDeclaration(p) && p.initializer === node) ||
		(ts.isPropertyDeclaration(p) && p.initializer === node) ||
		(ts.isPropertyAssignment(p) && p.initializer === node) ||
		ts.isShorthandPropertyAssignment(p) ||
		ts.isArrayLiteralExpression(p) ||
		(ts.isBinaryExpression(p) &&
			p.right === node &&
			p.operatorToken.kind === ts.SyntaxKind.EqualsToken)
	);
}

function flatten(d: TS.Diagnostic): string {
	return ts.flattenDiagnosticMessageText(d.messageText, " ");
}
