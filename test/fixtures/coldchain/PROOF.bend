import Base
import ./main.bend as K
import ./LAWS.bend as Laws

def Laws.above_max_is_refused(temp, min, max, probe, note, warm):
  %Equal.sym(Bool, F32.is_gt(temp, max), True{}, warm) : {K.judge(_, F32.is_lt(temp, min), temp, probe, note) == Fail{K.TooWarm{temp}} : Result<&1, &1, K.Refusal, K.Accepted>}
  {==}

def Laws.below_min_is_refused(temp, min, max, probe, note, warm, cold):
  %Equal.sym(Bool, F32.is_gt(temp, max), False{}, warm) : {K.judge(_, F32.is_lt(temp, min), temp, probe, note) == Fail{K.TooCold{temp}} : Result<&1, &1, K.Refusal, K.Accepted>}
  %Equal.sym(Bool, F32.is_lt(temp, min), True{}, cold) : {K.judge(False{}, _, temp, probe, note) == Fail{K.TooCold{temp}} : Result<&1, &1, K.Refusal, K.Accepted>}
  {==}

def Laws.in_range_is_accepted(temp, min, max, probe, note, warm, cold):
  %Equal.sym(Bool, F32.is_gt(temp, max), False{}, warm) : {K.judge(_, F32.is_lt(temp, min), temp, probe, note) == Done{K.Accepted{temp, probe, note}} : Result<&1, &1, K.Refusal, K.Accepted>}
  %Equal.sym(Bool, F32.is_lt(temp, min), False{}, cold) : {K.judge(False{}, _, temp, probe, note) == Done{K.Accepted{temp, probe, note}} : Result<&1, &1, K.Refusal, K.Accepted>}
  {==}
