import Laws

namespace Proofs

theorem never_exceeds_captured : Laws.never_exceeds_captured := by
  intro r a h
  unfold Kernel.decide at h
  split at h
  · cases h
  · split at h
    · cases h; assumption
    · cases h

theorem approves_what_was_asked : Laws.approves_what_was_asked := by
  intro r a h
  unfold Kernel.decide at h
  split at h
  · cases h
  · split at h
    · cases h; rfl
    · cases h

theorem zero_is_refused : Laws.zero_is_refused := by
  intro captured refunded
  simp [Kernel.decide]

end Proofs
