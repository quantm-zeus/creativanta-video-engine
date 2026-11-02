# Creativanta Video Engine

Independent code-first video composition and rendering service, consumed by Creativanta through asynchronous versioned APIs.

## Project principles

- NO self-hosted generative video GPU models and NO dependency on premium AI-video APIs.
- Reuse vetted open-source libraries where appropriate; verify licenses before adoption.
- Editable scene/timeline data owned by this service, with deterministic CPU rendering.
- Pluggable optional AI coding providers (Codex, AGY, OpenCode, DeepSeek and others), not a mandatory model.
- Tenant-safe API, signed callbacks, job queue, restricted rendering, storage and cost measurement.
- Keep this repository independent of the existing Creativanta repository.
- Phase 0 is documentation/scaffolding. It is **not** a functional video production engine.

## Project status

Architecture design has been assigned to Codex Sol. Detailed design documents and an implementation plan are in progress. AGY implementation must begin only after the design handoff has passed its required-document checks. Do not describe unimplemented features as shipped.

This file is a bootstrap project marker and will be expanded with the actual design.
