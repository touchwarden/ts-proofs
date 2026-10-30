import Base

# Plan quotas: a generic Limit, looked up per resource. Counters are U32;
# totals are computed as Nat so they can't wrap around.
type Limit<-A: Data> is Data:
  Limit{resource: A, max: U32}

type Resource is Data:
  Seats{}
  Storage{}
  Calls{}

type Request is Data:
  Request{limits: List<&2, Limit<Resource>>, resource: Resource, used: U32, adding: U32}

type Grant is Data:
  Grant{resource: Resource, total: Nat}

type Refusal is Data:
  NoLimit{}
  OverLimit{total: Nat, max: Nat}

def same(a: Resource, b: Resource) -> Bool:
  match a:
    case Seats{}:
      match b:
        case Seats{}:
          True{}
        case Storage{}:
          False{}
        case Calls{}:
          False{}
    case Storage{}:
      match b:
        case Storage{}:
          True{}
        case Seats{}:
          False{}
        case Calls{}:
          False{}
    case Calls{}:
      match b:
        case Calls{}:
          True{}
        case Seats{}:
          False{}
        case Storage{}:
          False{}

def first(hit: Bool, max: U32, rest: Maybe<&2, U32>) -> Maybe<&2, U32>:
  match hit:
    case True{}:
      Some{max}
    case False{}:
      rest

# The first limit listed for the resource wins.
def find(limits: List<&2, Limit<Resource>>, +r: Resource) -> Maybe<&2, U32>:
  match limits:
    case Nil{}:
      None{}
    case l <> rest:
      match l:
        case Limit{resource, max}:
          first(same(resource, r), max, find(rest, r))

def within(ok: Bool, +resource: Resource, +total: Nat, max: Nat) -> Result<&1, &1, Refusal, Grant>:
  match ok:
    case True{}:
      Done{Grant{resource, total}}
    case False{}:
      Fail{OverLimit{total, max}}

def check(found: Maybe<&2, U32>, +resource: Resource, +total: Nat) -> Result<&1, &1, Refusal, Grant>:
  match found:
    case None{}:
      Fail{NoLimit{}}
    case Some{max}:
      +cap = U32.to_nat(max)
      within(Nat.is_le(total, cap), resource, total, cap)

def grant(+r: Request) -> Result<&1, &1, Refusal, Grant>:
  match r:
    case Request{limits, resource, used, adding}:
      check(find(limits, resource), resource, Nat.add(U32.to_nat(used), U32.to_nat(adding)))

# Not the entry: the naive total, kept to show U32 wrapping in the tests.
def naive_total(used: U32, adding: U32) -> U32:
  U32.add(used, adding)
