import Base
import ./main.bend as Refunds
import ./LAWS.bend as Laws

# carries the guard's verdict b into the decision it picks
def picked(+c: Nat, +r: Nat, +a: Nat, b: Bool, e: {b == Refunds.fits(c, r, a) : Bool})
  -> {Laws.within(c, r, Refunds.pick(b, a)) == True{} : Bool}:
  match b:
    case True{}:
      %e : {_ == True{} : Bool}
      {==}
    case False{}:
      {==}

def Laws.never_exceeds_captured(captured, refunded, amount):
  match amount:
    case 0n:
      {==}
    case 1n++p:
      picked(captured, refunded, 1n+p, Refunds.fits(captured, refunded, 1n+p), {==})

def Laws.zero_is_refused(captured, refunded):
  {==}

def Laws.example_exactly_what_is_left():
  {==}
