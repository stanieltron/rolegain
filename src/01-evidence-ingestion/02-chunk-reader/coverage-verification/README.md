# Coverage verification

Every reader result is independently compared with its complete source chunk.
The verifier may identify material omissions or unsupported extraction, but an
omission is actionable only when its claimed exact quote exists in the chunk.

A blocking decision starts a targeted repair-delta call. The delta is validated
and merged deterministically before a new independent coverage check. This may
repeat for at most three repair rounds; the original reader output is never
regenerated wholesale. The verifier never opens tools, browses, or silently
changes canonical evidence.
