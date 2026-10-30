// A stand-in for the payments database: payments and the refunds recorded
// against them. `insertRefund` is the sensitive call. prove.json names it as
// the gate's sink, so only `recordRefund` may make it, and `recordRefund`
// only takes an approval from the proven kernel.

import {
	type RefundsApproved,
	refunds,
} from "../kernels/lasm/refunds/refunds.gen.ts";

export interface Payment {
	readonly id: string;
	readonly captured: number;
	refunded: number;
}

const payments = new Map<string, Payment>([
	["pay_1", { id: "pay_1", captured: 10_000, refunded: 4_000 }],
]);

export const ledger = {
	find(id: string): Payment | undefined {
		return payments.get(id);
	},
	insertRefund(id: string, amount: number): void {
		const payment = payments.get(id);
		if (payment) payment.refunded += amount;
	},
};

/**
 * The one place a refund is recorded. The approval says what the kernel
 * decided on, so the amount and totals come from it, not from the caller.
 */
export function recordRefund(
	paymentId: string,
	approval: RefundsApproved,
): void {
	// Spends the approval: it must have come from this kernel, in this process, once.
	const { input, result } = refunds.decide.consume(approval);
	const payment = ledger.find(paymentId);
	if (
		!payment ||
		payment.captured !== input.captured ||
		payment.refunded !== input.refunded
	)
		throw new Error(
			"The payment changed since the kernel decided; decide again.",
		);
	ledger.insertRefund(paymentId, result.amount);
}
