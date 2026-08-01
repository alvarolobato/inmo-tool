## Exit criteria / Validation

- [ ] **EC-1**: Drift guard runs `npm run build:knowledge && git diff --exit-code lib/knowledge.ts` between steps — *Verified by*: CI run.
- [ ] **EC-2**: Path uses a/b and a|b and $HOME and `back``ticks` — *Verified by*: file diff.
- [x] **EC-3**: Already checked — *Human-only*.
- [ ] **EC-10**: Must NOT be flipped when only EC-1 is requested — *Verified by*: test.
- [ ] **EC-11**: Also must NOT be flipped — *Human-only*.
