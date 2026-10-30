import Base

# Order states
type Status is Data:
  Cart{}
  Paid{}
  Shipped{}
  Refunded{}

type Action is Data:
  Pay{}
  Ship{}
  Refund{amount: Nat, restock: Bool}

type Request is Data:
  Request{status: Status, action: Action, paid: Nat}

type Step is Data:
  Step{to: Status, restock: Bool}

type Refusal is Data:
  NotAllowed{}
  OverPaid{paid: Nat}

def refund_if(ok: Bool, paid: Nat, restock: Bool) -> Result<&1, &1, Refusal, Step>:
  match ok:
    case True{}:
      Done{Step{Refunded{}, restock}}
    case False{}:
      Fail{OverPaid{paid}}

def refund(+paid: Nat, amount: Nat, restock: Bool) -> Result<&1, &1, Refusal, Step>:
  refund_if(Nat.is_le(amount, paid), paid, restock)

def step(+r: Request) -> Result<&1, &1, Refusal, Step>:
  match r:
    case Request{status, action, paid}:
      match status:
        case Cart{}:
          match action:
            case Pay{}:
              Done{Step{Paid{}, False{}}}
            case Ship{}:
              Fail{NotAllowed{}}
            case Refund{amount, restock}:
              Fail{NotAllowed{}}
        case Paid{}:
          match action:
            case Ship{}:
              Done{Step{Shipped{}, False{}}}
            case Refund{amount, restock}:
              refund(paid, amount, restock)
            case Pay{}:
              Fail{NotAllowed{}}
        case Shipped{}:
          match action:
            case Refund{amount, restock}:
              refund(paid, amount, restock)
            case Pay{}:
              Fail{NotAllowed{}}
            case Ship{}:
              Fail{NotAllowed{}}
        case Refunded{}:
          Fail{NotAllowed{}}
