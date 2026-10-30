# Checkout

One proven pricing kernel (`kernels/pricing`) decides the price in two places:

- **The browser** shows the customer the price, using Lasm's browser build of the kernel (`pnpm build:web`, then serve `web/` with any static server).
- **The server** charges it. `src/payments.ts` captures only the total in a `PricingApproved`, which only the kernel issues, so the server can't charge a different number.

The laws: the discount never goes past its cap, never goes past the goods, and the total is the goods, less the discount, plus shipping.

```sh
node demo.ts
# discount 5.00: charged 4999 cents
# discount over the cap: not charged: DiscountOverCap
# empty cart: not charged: EmptyCart
```

Lasm builds the kernel once for Node and once for the browser, from the same proven source. The two WebAssembly files differ, because the browser build is single-threaded. Each is a reproducible release build. This release hasn't yet run the browser page in a browser.
