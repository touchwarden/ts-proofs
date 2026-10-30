import Base
import ./main.bend as Wallet

# LAW: a zero withdrawal is always refused, whatever the balance and limits
law zero_is_refused:
  for balance: Nat
  for used: Nat
  for limit: Nat
  {Wallet.withdraw(Wallet.Request{balance, 0n, used, limit}) == Fail{Wallet.ZeroAmount{}} : Result<&1, &1, Wallet.Refusal, Wallet.Payout>}

# LAW: signed example: 40 from a balance of 100, nothing used today, daily limit 50, pays 40
law example_within_limits:
  {Wallet.withdraw(Wallet.Request{100n, 40n, 0n, 50n}) == Done{Wallet.Payout{40n}} : Result<&1, &1, Wallet.Refusal, Wallet.Payout>}

# LAW: asking for more than the balance is refused, whatever the daily limits
law over_balance_is_refused:
  for balance: Nat
  for extra: Nat
  for used: Nat
  for limit: Nat
  {Wallet.withdraw(Wallet.Request{balance, 1n+Nat.add(balance, extra), used, limit}) == Fail{Wallet.OverLimit{}} : Result<&1, &1, Wallet.Refusal, Wallet.Payout>}
