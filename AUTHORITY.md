# Authority Map

| Area | Authority |
|---|---|
| Visual presentation and canonical copy | Approved Figma frames |
| Authentication/onboarding through /home | Daali Auth + Onboarding Spec |
| Product behavior after /home | Daali Product Flow Spec |
| New Event domain invariants | Phase 0A–0D Technical Plan; Event Path Gate Independence Spec; phase-specific approved Event specs |
| Legacy Board / Game Day | SYSTEM-FLOW and its existing companion specs |
| Standalone Fundraiser | Its dedicated architecture spec, once approved |
| Standalone Raffle | Its dedicated architecture spec, once approved |

The Event Path Gate Independence Spec is at `docs/phase0/event-path-gate-independence.md`.

The repo is implementation evidence, not product authority.

If two governing specs genuinely conflict, stop and surface the conflict.
Never resolve it by following what the code does today.

## Persistence naming

New models use a Daali prefix (`DaaliEvent`, etc.) with their own table, enum
and index names. Product/domain language stays Event, `createEvent`, etc. No
`EventV2`-style names.
