/-
The checkout price. Amounts are whole cents. The browser shows this price
and the server charges it: both run this kernel, built by Lasm for each.
-/
namespace Kernel

structure Line where
  cents : Nat
  quantity : Nat

structure Cart where
  lines : List Line
  discount : Nat
  maxDiscount : Nat
  shipping : Nat

structure Price where
  subtotal : Nat
  discount : Nat
  shipping : Nat
  total : Nat

inductive Refusal where
  | EmptyCart
  | DiscountOverCap

def subtotal : List Line → Nat
  | [] => 0
  | l :: rest => l.cents * l.quantity + subtotal rest

def quote (c : Cart) : Except Refusal Price :=
  if c.lines.isEmpty then .error .EmptyCart
  else if c.discount > c.maxDiscount then .error .DiscountOverCap
  else
    let s := subtotal c.lines
    let d := min c.discount s
    .ok { subtotal := s, discount := d, shipping := c.shipping, total := s - d + c.shipping }

end Kernel
