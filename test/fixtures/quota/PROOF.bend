import Base
import ./main.bend as K
import ./LAWS.bend as Laws

def same_refl(r: K.Resource) -> {K.same(r, r) == True{} : Bool}:
  match r:
    case K.Seats{}:
      {==}
    case K.Storage{}:
      {==}
    case K.Calls{}:
      {==}

def Laws.no_limit_is_refused(resource, used, adding):
  {==}

def Laws.over_limit_is_refused(resource, max, used, adding, over):
  %Equal.sym(Bool, K.same(resource, resource), True{}, same_refl(resource)) : {K.check(K.first(_, max, None{}), resource, Nat.add(U32.to_nat(used), U32.to_nat(adding))) == Fail{K.OverLimit{Nat.add(U32.to_nat(used), U32.to_nat(adding)), U32.to_nat(max)}} : Result<&1, &1, K.Refusal, K.Grant>}
  %Equal.sym(Bool, Nat.is_le(Nat.add(U32.to_nat(used), U32.to_nat(adding)), U32.to_nat(max)), False{}, over) : {K.within(_, resource, Nat.add(U32.to_nat(used), U32.to_nat(adding)), U32.to_nat(max)) == Fail{K.OverLimit{Nat.add(U32.to_nat(used), U32.to_nat(adding)), U32.to_nat(max)}} : Result<&1, &1, K.Refusal, K.Grant>}
  {==}
