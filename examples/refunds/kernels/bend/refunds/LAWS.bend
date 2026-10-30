# The refund laws. The payments owner approves these; a PR is always judged by
# the copy on the base branch. They spell out the arithmetic themselves, so
# loosening a kernel helper cannot loosen a law.

import Base
import ./main.bend as Refunds

def within(captured: Nat, refunded: Nat, d: Result<&1, &1, Refunds.Refusal, Refunds.Approved>) -> Bool:
  match d:
    case Done{Refunds.Approved{amount}}:
      Nat.is_le(Nat.add(refunded, amount), captured)
    case Fail{e}:
      True{}

# LAW: an approved refund never takes the refunded total past what was captured
law never_exceeds_captured:
  for +captured: Nat
  for +refunded: Nat
  for +amount: Nat
  {within(captured, refunded, Refunds.decide(Refunds.Refund{captured, refunded, amount})) == True{} : Bool}

# LAW: a refund of 0 is always refused
law zero_is_refused:
  for captured: Nat
  for refunded: Nat
  {Refunds.decide(Refunds.Refund{captured, refunded, 0n}) == Fail{Refunds.ZeroAmount{}} : Result<&1, &1, Refunds.Refusal, Refunds.Approved>}

# LAW: signed example: 60 of 100 captured with 40 already refunded is approved
law example_exactly_what_is_left:
  {Refunds.decide(Refunds.Refund{100n, 40n, 60n}) == Done{Refunds.Approved{60n}} : Result<&1, &1, Refunds.Refusal, Refunds.Approved>}
