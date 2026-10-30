// Runs the example app: one refund that fits, one that doesn't, one of 0.
import { refund } from "./src/refund.ts";

console.log("refund 60.00:", await refund("pay_1", 6_000));
console.log("refund 0.01 more:", await refund("pay_1", 1));
console.log("refund 0:", await refund("pay_1", 0));
// The Lasm program keeps the event loop alive, as a server would.
process.exit(0);
