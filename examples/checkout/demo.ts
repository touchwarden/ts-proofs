// Runs the server side of the checkout example.
import { checkout } from "./src/server.ts";

const line = { cents: 2_500, quantity: 2 };
console.log(
	"discount 5.00:",
	await checkout({
		lines: [line],
		discount: 500,
		maxDiscount: 1_000,
		shipping: 499,
	}),
);
console.log(
	"discount over the cap:",
	await checkout({
		lines: [line],
		discount: 5_000,
		maxDiscount: 1_000,
		shipping: 499,
	}),
);
console.log(
	"empty cart:",
	await checkout({ lines: [], discount: 0, maxDiscount: 1_000, shipping: 499 }),
);
// The Lasm program keeps the event loop alive, as a server would.
process.exit(0);
