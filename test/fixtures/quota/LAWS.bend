import Base
import ./main.bend as K

# LAW: a resource with no limit listed is refused
law no_limit_is_refused:
  for resource: K.Resource
  for used: U32
  for adding: U32
  {K.grant(K.Request{Nil{}, resource, used, adding}) == Fail{K.NoLimit{}} : Result<&1, &1, K.Refusal, K.Grant>}

# LAW: going over the resource's limit is refused, for every counter value
law over_limit_is_refused:
  for resource: K.Resource
  for max: U32
  for used: U32
  for adding: U32
  for over: {Nat.is_le(Nat.add(U32.to_nat(used), U32.to_nat(adding)), U32.to_nat(max)) == False{} : Bool}
  {K.grant(K.Request{K.Limit{resource, max} <> Nil{}, resource, used, adding}) == Fail{K.OverLimit{Nat.add(U32.to_nat(used), U32.to_nat(adding)), U32.to_nat(max)}} : Result<&1, &1, K.Refusal, K.Grant>}
