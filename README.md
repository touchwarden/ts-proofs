# ts-proofs

Note:
This is very exploratory and WIP. It is mostly vibecoded. The inspiration comes from
[gdp-ts](https://github.com/rauchg/gdp-ts), the Vercel team's port of Ghosts of Departed Proofs,
and the rush of new formalization impls such as [Bend](https://bend-lang.com) and
[Lasm](https://github.com/Millillion/lasm) (Lean to wasm). See what you can take of use from here :)

Take what you like and leave the rest. Say hi: [@GesturingMan](https://x.com/GesturingMan)

**Make your TypeScript refuse to act unless a proven rule said yes.**

You write a business rule as a small kernel in [Lean](https://lean-lang.org) or [Bend](https://bend-lang.com), with laws such as "a refund never takes the total past what was captured", and prove them. `prove` then does three things:

1. **Prove.** On every pull request it checks the laws still hold, against the laws on your base branch. A PR can't weaken the rules it's judged by.
2. **Generate.** It turns the proven kernel into a TypeScript module: types for the kernel's inputs and answers, input checks, and a decider. When the kernel approves, the decider hands back an approval value. Nothing else in your code can make one.
3. **Gate.** It checks your TypeScript so the sensitive call (record the refund, capture the payment) only happens with that approval in hand. A forged approval, a cast, or a call that goes around the kernel is reported.

Tests show your code works on the inputs you tried. A proof covers every input, but only for the code that was proved. `prove` joins the two: the type checker carries the proof to the line of code that moves the money.

The rule, in Lean:

```lean
structure Refund where
  captured : Nat
  refunded : Nat
  amount : Nat

structure Approved where
  amount : Nat

inductive Refusal where
  | ZeroAmount
  | OverCaptured

def decide (r : Refund) : Except Refusal Approved :=
  if r.amount = 0 then .error .ZeroAmount
  else if r.refunded + r.amount ≤ r.captured then .ok { amount := r.amount }
  else .error .OverCaptured

-- A law, proved for every input
def never_exceeds_captured : Prop :=
  ∀ (r : Refund) (a : Approved), decide r = .ok a → r.refunded + a.amount ≤ r.captured
```

What `prove generate` gives your TypeScript:

```ts
// Generated from the proven kernel's Lean types.
import { refunds, type Refund, type RefundsApproved } from "./kernels/refunds/refunds.gen.ts";

export function recordRefund(paymentId: string, approval: RefundsApproved) {
	const { result } = refunds.decide.consume(approval); // spends it, once
	ledger.insertRefund(paymentId, result.amount);
}

export async function refund(paymentId: string, request: Refund) {
	const decision = await refunds.decide(request);
	if (!decision.ok) {
		switch (decision.result) {
			case "ZeroAmount": return "nothing to refund";
			case "OverCaptured": return "more than was captured";
			default: { const unhandled: never = decision.result; return unhandled; } // a new refusal in Lean breaks this
		}
	}
	recordRefund(paymentId, decision.approval);
	return "refunded";
}

recordRefund("pay_1", { input, result }); // type error: only refunds.decide makes one
recordRefund("pay_1", pricingApproval); // type error: approved by a different rule
approval.input.amount = 9_999; // type error: read-only
recordRefund("pay_1", { input, result } as RefundsApproved); // prove gate: forges a proof
ledger.insertRefund("pay_1", 6_000); // prove gate: called outside recordRefund
```

`prove check` reports by default and never blocks. You choose when it starts blocking.

## Pick a backend

The gate and the generated types work the same way for all three.

| Backend | You write | The app runs | A pass means |
| --- | --- | --- | --- |
| `lasm` | Lean | the proven Lean, compiled to WebAssembly by [Lasm](https://github.com/Millillion/lasm) | **kernel proven**: the code that decides is the code that was proved |
| `bend` | Bend | the proven Bend, compiled to JavaScript by Bend | **kernel proven** |
| `lean` | Lean | your own TypeScript | **model proven**: the Lean model is proved, and generated tests compare your TypeScript with it. Tested, not proved |

Plain `lean` suits teams that want to keep their TypeScript implementation. `prove generate` gives you `implementRefunds(yourFunction)` to issue approvals and `checkRefundsAgainstModel(yourFunction)` for your test suite. That runs your code and the proven model on the same inputs (your edge cases plus random ones) and lists every disagreement.

## Try it

You need Node 24 or newer. Install Lean with [elan](https://github.com/leanprover/elan) (the repo pins Lean 4.35.0, which Lasm requires) and, for Bend kernels, Bend:

```sh
curl -fsSL https://bend-lang.com/install.sh | sh   # only for Bend kernels
pnpm add -D github:touchwarden/ts-proofs
```

The [refunds example](examples/refunds) has the rule in all three backends, an app that records refunds only with an approval, and the attacks above as tests:

```sh
pnpm install && pnpm build
cd examples/refunds && pnpm generate && pnpm demo
# refund 60.00: refunded 6000
# refund 0.01 more: refused: OverCaptured
# refund 0: refused: ZeroAmount
```

The [checkout example](examples/checkout) prices a cart with one proven Lean kernel in two places: in the browser for the price the customer sees, and on the server for the price you charge. The server can only charge the total the kernel approved. Lasm builds the kernel separately for each target, from the same proven source.

## Set up a repository

1. Write the kernel. For Lean: `Kernel.lean` (the decision, `A → Except Refusal Approved`), `Laws.lean` (each law a `def <name> : Prop` in `namespace Laws`), and `Proof.lean` (each proof a `theorem <name> : Laws.<name>` in `namespace Proofs`). For Bend: `main.bend`, `LAWS.bend`, `PROOF.bend`.
2. Describe the rules in `prove.json` at the repository root:

```json
{
	"rules": [
		{
			"id": "refund-within-captured",
			"statement": "An approved refund never takes the refunded total past what was captured.",
			"backend": "lasm",
			"kernel": "kernels/refunds",
			"law": "never_exceeds_captured",
			"entry": "Kernel.decide",
			"proofType": "RefundsApproved",
			"gate": {
				"project": ".",
				"trusted": ["kernels/refunds/refunds.gen.ts"],
				"sink": { "call": "ledger.insertRefund", "only_in": "recordRefund" }
			}
		}
	]
}
```

3. Run `prove generate`. It refuses to write anything unless every law in the kernel is proved.
4. Commit all of it to your main branch. `prove check` always reads `prove.json`, the laws and the gate's trusted files from the base branch.
5. Run `prove check --base origin/main` in CI.

Lean kernels can use `Nat`, `Bool`, `String`, `List`, `Option`, structures and enumerations. In TypeScript, numbers are whole numbers up to 2^48 − 1. Larger ones are refused before they reach the kernel.

## In CI

There's no Action to install; the CLI is the whole thing. A minimal GitHub workflow:

```yaml
on: pull_request            # never pull_request_target: see below
jobs:
  prove:
    runs-on: ubuntu-latest  # a GitHub-hosted, throwaway machine
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain leanprover/lean4:v4.35.0 && echo "$HOME/.elan/bin" >> "$GITHUB_PATH"
      - run: npm ci
      - run: npx prove check --base origin/${{ github.base_ref }} --format github --allow-repo-execution
```

- **Reporting, not blocking, is the default.** Results appear as annotations and in the job summary. Add `--fail-on failure` to block failing proofs or bypassed gates, or `--fail-on review` to also hold PRs that edit laws, proofs or trusted files.
- **Lean proofs run the PR's code.** Lean runs code while it checks a proof, so Lean and Lasm rules only run with `--allow-repo-execution`. Pass it only on throwaway runners: GitHub-hosted runners on `pull_request` give fork PRs a fresh machine, a read-only token and no secrets. Don't pass it on self-hosted runners.
- **`pull_request_target` never runs Lean proofs,** with or without the flag. That event runs with write access and your secrets.

## What a pass does and doesn't cover

- **Proved:** the laws, for every input, for the kernel source. Each Lean declaration is re-checked by Lean's kernel (`leanchecker`). A separate audit program, which never runs the PR's code, confirms each proof states exactly the base law and uses only Lean's standard axioms. `sorry`, `native_decide` and new axioms fail.
- **Pinned to base:** each law must mean the same as on the base branch. A PR can change kernel function bodies, but not the types, instances or signatures a law relies on. So it can't, say, redefine `≤` under an unchanged law.
- **Checked, not proved:** the gate is a static check of your TypeScript. It catches casts, `any`, forged approvals, second deciders, suppression comments and calls around the sensitive function. It isn't a proof, and it trusts TypeScript's `strict` checks.
- **Trusted:** the Lean and Bend toolchains, Lasm's compiler and runtime, the generated `Main.lean` wrapper (`prove generate --check` catches edits to it), and the JSON bridge between JavaScript and the kernel.

## Status

Version 0.1, an early release. Known limits:

- Lean must be exactly 4.35.0 and Lasm 0.3.5. The `lasm` backend inherits Lasm's limits, including Node 24+ and a 512 MB minimum memory.
- The checkout page's browser build compiles, but this release hasn't run it in a browser yet.
- A process can load several Lasm kernels, one after another. Running many at once is untested.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
