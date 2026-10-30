/-
The refund decision. Amounts are whole cents.
-/
namespace Kernel

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

end Kernel
