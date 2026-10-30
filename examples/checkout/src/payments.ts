// A stand-in for the payment provider. `provider.capture` is the sensitive
// call: prove.json lets only `charge` make it, and `charge` only takes a
// price the proven kernel approved.

import {
	type PricingApproved,
	pricing,
} from "../kernels/pricing/pricing.gen.ts";

export const captured: number[] = [];

export const provider = {
	capture(cents: number): void {
		captured.push(cents);
	},
};

/** Charges exactly the total the kernel computed: the caller cannot pass an amount. */
export function charge(approval: PricingApproved): number {
	const { result } = pricing.quote.consume(approval);
	provider.capture(result.total);
	return result.total;
}
