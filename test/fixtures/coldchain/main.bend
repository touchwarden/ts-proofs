import Base

# A temperature reading from a cold-chain probe, checked against the
# shipment's allowed range before the shipment is accepted.
type Reading is Data:
  Reading{temp: F32, min: F32, max: F32, probe: String, note: Maybe<&2, String>}

type Accepted is Data:
  Accepted{temp: F32, probe: String, note: Maybe<&2, String>}

type Refusal is Data:
  TooWarm{temp: F32}
  TooCold{temp: F32}

def judge(warm: Bool, cold: Bool, temp: F32, probe: String, note: Maybe<&2, String>) -> Result<&1, &1, Refusal, Accepted>:
  match warm:
    case True{}:
      Fail{TooWarm{temp}}
    case False{}:
      match cold:
        case True{}:
          Fail{TooCold{temp}}
        case False{}:
          Done{Accepted{temp, probe, note}}

def accept(+r: Reading) -> Result<&1, &1, Refusal, Accepted>:
  match r:
    case Reading{temp, min, max, probe, note}:
      judge(F32.is_gt(temp, max), F32.is_lt(temp, min), temp, probe, note)
