// The server side of checkout. It prices the cart with the same proven
// kernel the browser used to show the price, and charges only that.

import { type Cart, pricing } from "../kernels/pricing/pricing.gen.ts";
import { charge } from "./payments.ts";

export async function checkout(cart: Cart): Promise<string> {
	const quote = await pricing.quote(cart);
	if (!quote.ok) return `not charged: ${quote.result}`;
	return `charged ${charge(quote.approval)} cents`;
}
