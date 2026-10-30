import Base
import ./main.bend as Wallet
import ./LAWS.bend as Laws

def Laws.zero_is_refused(balance, used, limit):
  {==}

def Laws.example_within_limits():
  {==}

# helper: 1 + balance + extra is always greater than balance
def above(b: Nat, e: Nat) -> {Nat.cmp(1n+Nat.add(b, e), b) == GT{} : Cmp}:
  match b:
    case 0n:
      {==}
    case 1n+p:
      above(p, e)

def Laws.over_balance_is_refused(balance, extra, used, limit):
  %Equal.sym(Cmp, Nat.cmp(1n+Nat.add(balance, extra), balance), GT{}, above(balance, extra)) : {Wallet.pick(Bool.and(Cmp.is_le(_), Nat.is_le(Nat.add(used, 1n+Nat.add(balance, extra)), limit)), 1n+Nat.add(balance, extra)) == Fail{Wallet.OverLimit{}} : Result<&1, &1, Wallet.Refusal, Wallet.Payout>}
  {==}
