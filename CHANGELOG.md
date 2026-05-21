# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

## [0.3.2] - 2026-05-21

Wire-passthrough verification for the new `from` / `to` query params on `listReservations`. Implements `cycles-protocol-v0.yaml` revision 2026-05-21 ([runcycles/cycles-protocol#97](https://github.com/runcycles/cycles-protocol/pull/97)) on the client side; runcycles/cycles-server#160 ships the server impl.

### Added

- Regression test on `client.listReservations` confirming that `from` / `to` ISO-8601 date-time params are URL-encoded and forwarded to the query string. The client's `params?: Record<string, string>` signature already accepted these — the test locks the contract so future tightening cannot drop them silently. Both colons are URL-encoded (`from=2026-05-21T00%3A00%3A00Z`).

### Notes

- No protocol or wire-format change. Servers older than v0.1.25.20 silently ignore the new params per the additive-parameter guarantee in `cycles-protocol-v0.yaml`.
- 316 tests pass; coverage 98.4% statements / 99.62% lines (gate ≥95% per `CLAUDE.md`).

## [0.3.1] - 2026-05-07

npm metadata refresh for category-search discovery. **No code changes** — bundle and runtime behavior are identical to 0.3.0.

### Changed

- `package.json`: rewrote `description` to lead with the cost / action / audit pillars (*"TypeScript AI agent runtime control — enforce LLM cost limits, action permissions, and audit trails for agents before execution."*) and expanded `keywords` from 15 to 26. Drops legacy keywords (`billing`, `metering`, `api-client`, `ai`, `llm`, `agents`, `token-budget`, `spend-limit`) in favor of category-search variants (`ai-agent`, `agent-budget`, `budget-control`, `cost-enforcement`, `spending-limit`, `llm-cost`, `runtime-authority`, `action-control`, `action-authority`, `audit-trail`, `audit`, `compliance`, `multi-tenant`) plus framework targeting (`langchain`, `langgraph`, `openai-agents`, `vercel-ai-sdk`, `mcp`).

## [0.3.0] - 2026-04-27

Java parity: dynamic subject and action fields on `withCycles`.

### Added

- Dynamic subject + action fields on `withCycles` config — `tenant`, `workspace`, `app`, `workflow`, `agent`, `toolset`, `actionKind`, and `actionName` now accept `(...args: TArgs) => string | undefined` in addition to a static string. Callables are resolved against the wrapped function's per-call args; returning `undefined` falls through to the client-config default (subject) or `"unknown"` (action). Static strings unchanged. Java parity with [`cycles-spring-boot-starter#50`](https://github.com/runcycles/cycles-spring-boot-starter/pull/50). ([#72](https://github.com/runcycles/cycles-client-typescript/issues/72))

## [0.2.0] - 2026-03-24

Bug fixes, support 0.1.24 spec.

### Added

- Add badges to README for npm, CI, and license ([#24](https://github.com/runcycles/cycles-client-typescript/pull/24))
- Add documentation links section to README ([#25](https://github.com/runcycles/cycles-client-typescript/pull/25))
- Add budget and extension error codes, charged amount to event response ([#29](https://github.com/runcycles/cycles-client-typescript/pull/29))

### Changed

- Document nested withCycles behavior and recommended patterns ([#26](https://github.com/runcycles/cycles-client-typescript/pull/26))
- Claude/analyze spring issue 29 v biy9 ([#27](https://github.com/runcycles/cycles-client-typescript/pull/27))
- Change default overage policy from REJECT to ALLOW_IF_AVAILABLE ([#28](https://github.com/runcycles/cycles-client-typescript/pull/28))
- chore: bump version to 0.2.0 for protocol v0.1.24 ([#30](https://github.com/runcycles/cycles-client-typescript/pull/30))

## [0.1.2] - 2026-03-19

Fix type safety in WithCyclesConfig generics.

### Added

- Add AUDIT.md documenting protocol conformance ([#19](https://github.com/runcycles/cycles-client-typescript/pull/19))
- Add AWS Bedrock and Google Gemini budget governance examples ([#20](https://github.com/runcycles/cycles-client-typescript/pull/20))
- Add parent README for examples directory ([#21](https://github.com/runcycles/cycles-client-typescript/pull/21))
- Add API key creation guide to documentation and examples ([#22](https://github.com/runcycles/cycles-client-typescript/pull/22))

### Fixed

- Fix type safety in WithCyclesConfig generics and add compile-time type tests ([#23](https://github.com/runcycles/cycles-client-typescript/pull/23))

## [0.1.1] - 2026-03-13

Updates and bug and stability fixes, more SDK examples.

### Added

- Add manual workflow_dispatch trigger to CI publish ([#4](https://github.com/runcycles/cycles-client-typescript/pull/4))
- Add comprehensive test coverage for lifecycle, streaming, and error handling ([#7](https://github.com/runcycles/cycles-client-typescript/pull/7))
- Add comprehensive examples for Cycles budget governance ([#9](https://github.com/runcycles/cycles-client-typescript/pull/9))
- Claude/expand ai examples zj dwy ([#10](https://github.com/runcycles/cycles-client-typescript/pull/10))
- Add ESLint with typescript-eslint/recommended and coverage thresholds ([#12](https://github.com/runcycles/cycles-client-typescript/pull/12))
- Add lint and coverage enforcement to CI ([#13](https://github.com/runcycles/cycles-client-typescript/pull/13))
- Add test for commit retry exhaustion warning ([#18](https://github.com/runcycles/cycles-client-typescript/pull/18))

### Changed

- Comprehensive README rewrite for npm publication ([#5](https://github.com/runcycles/cycles-client-typescript/pull/5))
- Optimize initialization and add async disposal support ([#6](https://github.com/runcycles/cycles-client-typescript/pull/6))
- Update TEST_COVERAGE_ANALYSIS.md with final coverage results ([#8](https://github.com/runcycles/cycles-client-typescript/pull/8))
- Document withCycles client caching behavior in default client section ([#11](https://github.com/runcycles/cycles-client-typescript/pull/11))
- Document commit rollback behavior for failed commits in streaming sec… ([#14](https://github.com/runcycles/cycles-client-typescript/pull/14))
- Warn on commit retry exhaustion in CommitRetryEngine ([#15](https://github.com/runcycles/cycles-client-typescript/pull/15))

### Removed

- Remove dead code: unused constants, validateReservationId, makeClient ([#16](https://github.com/runcycles/cycles-client-typescript/pull/16))
- Remove CyclesTransportError from public exports ([#17](https://github.com/runcycles/cycles-client-typescript/pull/17))

## [0.1.0] - 2026-03-13

Initial release.

### Added

- Add TypeScript client for Cycles budget-management protocol ([#1](https://github.com/runcycles/cycles-client-typescript/pull/1))
- Add comprehensive mapper functions for wire format conversion ([#2](https://github.com/runcycles/cycles-client-typescript/pull/2))
- Add CI/CD pipeline and improve package metadata ([#3](https://github.com/runcycles/cycles-client-typescript/pull/3))
