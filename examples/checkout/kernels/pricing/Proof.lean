import Laws

namespace Proofs

theorem discount_within_cap : Laws.discount_within_cap := by
  intro c p h
  unfold Kernel.quote at h
  split at h
  · cases h
  · split at h
    · cases h
    · cases h
      simp only
      omega

theorem discount_within_subtotal : Laws.discount_within_subtotal := by
  intro c p h
  unfold Kernel.quote at h
  split at h
  · cases h
  · split at h
    · cases h
    · cases h
      exact Nat.min_le_right _ _

theorem total_adds_up : Laws.total_adds_up := by
  intro c p h
  unfold Kernel.quote at h
  split at h
  · cases h
  · split at h
    · cases h
    · cases h
      simp only
      omega

end Proofs
