import Base

# n-of-m release sign-off: a release needs `required` distinct reviewers,
# and the author's own review never counts.
type Request is Data:
  Request{author: String, reviewers: List<&2, String>, required: Nat}

type Release is Data:
  Release{approvals: Nat, reviewers: List<&2, String>}

type Refusal is Data:
  NotEnough{have: Nat, need: Nat}

def member(+name: String, seen: List<&2, String>) -> Bool:
  match seen:
    case Nil{}:
      False{}
    case h <> t:
      Bool.or(String.eq(h, name), member(name, t))

def plus_one_unless(skip: Bool, n: Nat) -> Nat:
  match skip:
    case True{}:
      n
    case False{}:
      1n+n

# Every name goes into `seen`, so a repeat is skipped; the author is never counted.
def count(reviewers: List<&2, String>, +author: String, +seen: List<&2, String>) -> Nat:
  match reviewers:
    case Nil{}:
      0n
    case h <> t:
      +name = h
      plus_one_unless(Bool.or(String.eq(name, author), member(name, seen)), count(t, author, name <> seen))

def pick(ok: Bool, +have: Nat, need: Nat, reviewers: List<&2, String>) -> Result<&1, &1, Refusal, Release>:
  match ok:
    case True{}:
      Done{Release{have, reviewers}}
    case False{}:
      Fail{NotEnough{have, need}}

def decide(+have: Nat, +need: Nat, reviewers: List<&2, String>) -> Result<&1, &1, Refusal, Release>:
  pick(Nat.is_ge(have, need), have, need, reviewers)

def release(+r: Request) -> Result<&1, &1, Refusal, Release>:
  match r:
    case Request{author, reviewers, required}:
      +listed = reviewers
      decide(count(listed, author, Nil{}), required, listed)
