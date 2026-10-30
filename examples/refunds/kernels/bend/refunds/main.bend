# The refund decision. Amounts are whole cents.

import Base

type Refund is Data:
  Refund{captured: Nat, refunded: Nat, amount: Nat}

type Approved is Data:
  Approved{amount: Nat}

type Refusal is Data:
  ZeroAmount{}
  OverCaptured{}

def fits(captured: Nat, refunded: Nat, amount: Nat) -> Bool:
  Nat.is_le(Nat.add(refunded, amount), captured)

def pick(ok: Bool, amount: Nat) -> Result<&1, &1, Refusal, Approved>:
  match ok:
    case True{}:
      Done{Approved{amount}}
    case False{}:
      Fail{OverCaptured{}}

def decide(+r: Refund) -> Result<&1, &1, Refusal, Approved>:
  match r:
    case Refund{captured, refunded, amount}:
      match amount:
        case 0n:
          Fail{ZeroAmount{}}
        case 1n++p:
          pick(fits(captured, refunded, 1n+p), 1n+p)
