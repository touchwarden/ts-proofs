import Base
import ./main.bend as K

# LAW: with no reviewers, a release that needs any review is refused
law nobody_reviewed_is_refused:
  for author: String
  for need: Nat
  {K.release(K.Request{author, Nil{}, 1n+need}) == Fail{K.NotEnough{0n, 1n+need}} : Result<&1, &1, K.Refusal, K.Release>}

# LAW: the author reviewing their own release doesn't count
law self_review_does_not_count:
  for author: String
  for reviewer: String
  for need: Nat
  for same: {String.eq(reviewer, author) == True{} : Bool}
  {K.release(K.Request{author, reviewer <> Nil{}, 1n+need}) == Fail{K.NotEnough{0n, 1n+need}} : Result<&1, &1, K.Refusal, K.Release>}

# LAW: signed example: the same reviewer listed twice counts once
law repeated_reviewer_counts_once:
  {K.release(K.Request{"ana", ["bo", "bo"], 2n}) == Fail{K.NotEnough{1n, 2n}} : Result<&1, &1, K.Refusal, K.Release>}

# LAW: signed example: two distinct reviewers who aren't the author release it, and the release lists who was asked
law two_distinct_reviewers_release:
  {K.release(K.Request{"ana", ["bo", "ana", "cy"], 2n}) == Done{K.Release{2n, ["bo", "ana", "cy"]}} : Result<&1, &1, K.Refusal, K.Release>}
