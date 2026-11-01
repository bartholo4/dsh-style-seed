# Experimental .14: cloud validation, 2026-11-01

This report separates regression checks, browser protocol checks, and a small live-provider smoke test. It is **not evidence of improved intelligence, answer quality, efficiency, or a guaranteed reasoning phrase**.

## Environment and scope

- Local tested code snapshot: `26b5c3d90594be4caaa4c71ceab54bfc27ed4c10` (`0.2.0-experimental.14`).
- Official DSH `0.2.2-alpha.2`, Node `24.22.1`, isolated cloud Web profiles.
- Live provider/model: d1api, `deepseek-v4.1-flash`, `max` reasoning; requested output cap: 4096 tokens. The selected effort was also checked in the provider console.
- Three synthetic task pairs: arithmetic, scheduling constraints, and strict JSON output. Each pair used the same task in separate new OFF/ON sessions, with OFF run first. Six live model calls were made. This was not randomized or repeated across models.
- No raw prompts, answers, reasoning, seed content, account details, credentials, quota records, or private logs are included here.

## 1. Reproducible regression gate

`npm run check`, with `DSH_RUNTIME_NODE_MODULES` pointing to the pinned installed host: **142 passed, 0 failed, 0 skipped**. Generated client consistency, JavaScript syntax and diff whitespace checks passed. There is no separate TypeScript or lint toolchain.

Coverage includes actual host services and gateway RPC with synthetic model responses, accepted-input draining, session ownership/edit admission, read-only RPC retry, stale responses/unmount, first-success seeding, tool/image mappings, native canceled-history retry, and missing output-cap diagnostics. The strict gate rejects an absent/mismatched host or skipped tests. The portable suite is explicitly partial coverage, not this release gate.

## 2. Actual Web UI with a loopback mock provider

The following browser flows passed:

- Default OFF; explicit ON in a new session.
- First successful reply includes the sample once; later reply omits it.
- A harmless unknown-tool error and its continuation retain the sample until the first successful reply. This is not a successful business-tool execution test.
- Intentional provider failure followed by retry.
- Stop/cancel during a reasoning-only partial response, followed by retry in the same ON session, then an unseeded later turn.
- OFF recovery after a failed request; a started session cannot be re-enabled.

These checks exposed and verified fixes for a misleading missing-output-cap error and legacy restoration incorrectly rejecting native interrupted history. The mock fixture observed the outgoing sample counts without storing request bodies in its evidence log. Seven disposable mock-profile session files, containing 197 records, had no exact sample message/reasoning strings.

## 3. Small live-provider OFF/ON smoke test

All six outputs satisfied the tested arithmetic, scheduling, or JSON requirements. The table records provider-reported token counts and only a boolean observation of the reasoning opening—not raw reasoning.

| Synthetic task | Switch | Correct | Input tokens | Output tokens | Input cache-hit tokens | Starts with “We need” |
|---|---|---|---:|---:|---:|---|
| Arithmetic | OFF | Yes | 9,220 | 134 | 0 | No |
| Arithmetic | ON | Yes | 9,387 | 82 | 8,704 | Yes |
| Scheduling | OFF | Yes | 9,212 | 246 | 8,704 | Yes |
| Scheduling | ON | Yes | 9,379 | 295 | 8,832 | Yes |
| Strict JSON | OFF | Yes | 9,235 | 105 | 8,704 | No |
| Strict JSON | ON | Yes | 9,402 | 91 | 8,832 | Yes |

The opening occurred in **1/3 OFF and 3/3 ON** responses. It can occur naturally when OFF; three ON observations do not establish reliable triggering. Output-token changes were mixed: lower with ON for two tasks, higher for scheduling. Cache states differed, especially in the first pair. Neither these counts nor the observed timings establish a speed, cost, efficiency, or capability advantage. The tests were small, simple, sequential, and limited to one provider/model configuration.

### First-call transport uncertainty

The first OFF call produced a correct completed answer in the Web UI and a successful provider record with usage. The separate QA guard nevertheless recorded `stream-interrupted`; it had not recorded whether the original terminal marker was observed. That uncertainty is retained.

A deterministic fixture reproduced the guard misclassifying an SDK closing after a successful finish and terminal marker. The guard was corrected and independently reviewed. An explicitly reviewed acknowledgment allowed bounded resumption without deleting the original interruption record or resetting call counts. This does **not** retrospectively prove the first call's terminal sequence. Live calls 2–6 subsequently recorded clean terminal streams.

### Persistence and privacy boundary

Before cleanup, fourteen isolated live-profile session files, containing 281 records, had **zero exact sample message/reasoning strings**. This checks literal persistence, not every possible paraphrase or influence on a model answer. It does not establish that later answers are unaffected by the first reply. After the six-call batch, the paid release was removed and the test runtime stopped. Temporary credential storage, isolated live-profile/runtime data, and private startup logs were removed; only sanitized evidence was retained. Cleanup was verified without reading credential contents.

## Remaining limitations

- No claim of general answer-quality, intelligence, efficiency, cost, or latency improvement.
- No broad provider, long-session, production business-tool, or daily Electron validation.
- Safe hot unload is still unproven: a late submission after the final idle snapshot can miss the sample. Stop all submissions, drain work, and shut down DSH before maintenance.
- Legacy-reference migration/removal remains a separate limitation. This smoke test does not certify production use, migration, or rollback.
