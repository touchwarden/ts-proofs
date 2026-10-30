// What an API handler does: ask the proven kernel, then act on its answer.
// There is no way to call recordRefund without the kernel saying yes.

import { refunds } from "../kernels/lasm/refunds/refunds.gen.ts";
import { ledger, recordRefund } from "./ledger.ts";

export async function refund(
	paymentId: string,
	amount: number,
): Promise<string> {
	const payment = ledger.find(paymentId);
	if (!payment) return "no such payment";
	const decision = await refunds.decide({
		captured: payment.captured,
		refunded: payment.refunded,
		amount,
	});
	if (!decision.ok) return `refused: ${decision.result}`;
	recordRefund(paymentId, decision.approval);
	return `refunded ${decision.approval.result.amount}`;
}
