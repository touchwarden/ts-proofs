/-
The pricing laws. The owner approves these; a PR is judged by the copy on
the base branch.
-/
import Kernel

namespace Laws

/-- The discount never goes past the cap the business set. -/
def discount_within_cap : Prop :=
  ∀ (c : Kernel.Cart) (p : Kernel.Price),
    Kernel.quote c = .ok p → p.discount ≤ c.maxDiscount

/-- The discount never goes past the goods, so the total never drops below shipping. -/
def discount_within_subtotal : Prop :=
  ∀ (c : Kernel.Cart) (p : Kernel.Price),
    Kernel.quote c = .ok p → p.discount ≤ p.subtotal

/-- The total adds up: goods, less the discount, plus shipping. -/
def total_adds_up : Prop :=
  ∀ (c : Kernel.Cart) (p : Kernel.Price),
    Kernel.quote c = .ok p → p.total + p.discount = p.subtotal + c.shipping

end Laws
