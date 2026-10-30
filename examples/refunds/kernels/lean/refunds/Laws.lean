/-
The refund laws. The payments owner approves these; a PR is always judged by
the copy on the base branch, and they must mean the same there.
-/
import Kernel

namespace Laws

/-- An approved refund never takes the refunded total past what was captured. -/
def never_exceeds_captured : Prop :=
  ∀ (r : Kernel.Refund) (a : Kernel.Approved),
    Kernel.decide r = .ok a → r.refunded + a.amount ≤ r.captured

/-- An approved refund is for exactly the amount asked for. -/
def approves_what_was_asked : Prop :=
  ∀ (r : Kernel.Refund) (a : Kernel.Approved),
    Kernel.decide r = .ok a → a.amount = r.amount

/-- A refund of 0 is always refused. -/
def zero_is_refused : Prop :=
  ∀ (captured refunded : Nat),
    Kernel.decide { captured, refunded, amount := 0 } = .error .ZeroAmount

end Laws
