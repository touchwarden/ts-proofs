import Base
import ./main.bend as K
import ./LAWS.bend as Laws

def Laws.nobody_reviewed_is_refused(author, need):
  {==}

def Laws.self_review_does_not_count(author, reviewer, need, same):
  %Equal.sym(Bool, String.eq(reviewer, author), True{}, same) : {K.decide(K.plus_one_unless(Bool.or(_, K.member(reviewer, Nil{})), K.count(Nil{}, author, reviewer <> Nil{})), 1n+need, reviewer <> Nil{}) == Fail{K.NotEnough{0n, 1n+need}} : Result<&1, &1, K.Refusal, K.Release>}
  {==}

def Laws.repeated_reviewer_counts_once():
  {==}

def Laws.two_distinct_reviewers_release():
  {==}
