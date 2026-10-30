import Base

type Request is Data:
  Request{balance: Nat, amount: Nat, daily_used: Nat, daily_limit: Nat}

type Payout is Data:
  Payout{amount: Nat}

type Refusal is Data:
  ZeroAmount{}
  OverLimit{}

def pick(ok: Bool, amount: Nat) -> Result<&1, &1, Refusal, Payout>:
  match ok:
    case True{}:
      Done{Payout{amount}}
    case False{}:
      Fail{OverLimit{}}

def within(+r: Request) -> Bool:
  match r:
    case Request{balance, amount, daily_used, daily_limit}:
      Bool.and(Nat.is_le(amount, balance), Nat.is_le(Nat.add(daily_used, amount), daily_limit))

def withdraw(+r: Request) -> Result<&1, &1, Refusal, Payout>:
  match r:
    case Request{balance, amount, daily_used, daily_limit}:
      match amount:
        case 0n:
          Fail{ZeroAmount{}}
        case 1n++p:
          pick(within(Request{balance, 1n+p, daily_used, daily_limit}), 1n+p)
