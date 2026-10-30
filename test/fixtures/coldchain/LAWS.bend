import Base
import ./main.bend as K

# LAW: a reading above the maximum is refused, whatever the note says
law above_max_is_refused:
  for temp: F32
  for min: F32
  for max: F32
  for probe: String
  for note: Maybe<&2, String>
  for warm: {F32.is_gt(temp, max) == True{} : Bool}
  {K.accept(K.Reading{temp, min, max, probe, note}) == Fail{K.TooWarm{temp}} : Result<&1, &1, K.Refusal, K.Accepted>}

# LAW: a reading below the minimum is refused
law below_min_is_refused:
  for temp: F32
  for min: F32
  for max: F32
  for probe: String
  for note: Maybe<&2, String>
  for warm: {F32.is_gt(temp, max) == False{} : Bool}
  for cold: {F32.is_lt(temp, min) == True{} : Bool}
  {K.accept(K.Reading{temp, min, max, probe, note}) == Fail{K.TooCold{temp}} : Result<&1, &1, K.Refusal, K.Accepted>}

# LAW: a reading inside the range is accepted, and the approval records that exact reading and note
law in_range_is_accepted:
  for temp: F32
  for min: F32
  for max: F32
  for probe: String
  for note: Maybe<&2, String>
  for warm: {F32.is_gt(temp, max) == False{} : Bool}
  for cold: {F32.is_lt(temp, min) == False{} : Bool}
  {K.accept(K.Reading{temp, min, max, probe, note}) == Done{K.Accepted{temp, probe, note}} : Result<&1, &1, K.Refusal, K.Accepted>}
