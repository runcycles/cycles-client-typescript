# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

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
