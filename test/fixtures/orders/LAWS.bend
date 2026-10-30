import Base
import ./main.bend as Orders

# LAW: a refunded order never moves again, whatever the action
law refunded_is_final:
  for action: Orders.Action
  for paid: Nat
  {Orders.step(Orders.Request{Orders.Refunded{}, action, paid}) == Fail{Orders.NotAllowed{}} : Result<&1, &1, Orders.Refusal, Orders.Step>}

# LAW: signed example: a paid order can ship, without restocking
law example_paid_ships:
  {Orders.step(Orders.Request{Orders.Paid{}, Orders.Ship{}, 50n}) == Done{Orders.Step{Orders.Shipped{}, False{}}} : Result<&1, &1, Orders.Refusal, Orders.Step>}
