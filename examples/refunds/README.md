# Refunds

One rule, proved three ways: **an approved refund never takes the refunded total past what was captured**, and a refund of 0 is refused.

- `kernels/lasm/refunds`: Lean, compiled to WebAssembly. The app in `src/` uses this one.
- `kernels/bend/refunds`: Bend, compiled to JavaScript. Same rule, same TypeScript types, but the decider is synchronous.
- `kernels/lean/refunds`: a Lean model. The generated module wraps your own TypeScript implementation and tests it against the model.

`src/ledger.ts` holds the sensitive call, `ledger.insertRefund`. `prove.json` lets only `recordRefund` make it, and `recordRefund` takes a `RefundsApproved`, which only the kernel can issue.

```sh
node demo.ts                       # three refunds: one fits, two are refused
prove generate                     # rebuild the generated modules from prove.json
prove gate                         # check every call site holds an approval
```

`test/refunds-example.test.ts` in the repo root runs the attacks against a copy of this example: a forged approval, a direct ledger write, a second decider, and a kernel bug alongside a weakened law. Each one is caught.
