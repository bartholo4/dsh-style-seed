# Changelog

## 0.2.0-experimental.15

- Support DSH `0.2.2-rc.3` alongside `0.2.2-alpha.2` (`engines.dsh`, peer dependency ranges, `./cordis.patch.yml` export, strict single-version host gate across supported versions, and dual-host CI matrix).
- Fix false `"weneed开关的会话上下文已满"` preflight rejections during multi-step tool/image first turns and on models with high `maxTokens`: strip non-wire replay metadata and binary/base64 image payloads before byte counting (images remain budgeted at 1,024 tokens each), convert UTF-8 text bytes with a conservative ~3 bytes/token bound, and cap preflight output reservation to `Math.min(maxTokens, Math.floor(contextWindow / 4))` while still rejecting genuinely overfull contexts.
- Normalize CRLF line endings in `scripts/build-client.mjs` and add `.gitattributes` so `npm run check:client` succeeds on Windows checkouts as well as Linux CI.
- Document hybrid-model reasoning effort behavior (some models such as `deepseek-v4.1-flash` may require selecting an explicit reasoning effort such as `High` or `Max` when `Default` does not emit reasoning blocks).
- **Still experimental:** hot unload is not atomic with host input admission. Stop all submissions, drain work, and shut down DSH before updates or removal.

## 0.2.0-experimental.14

- Separate switch-edit admission from live agent ownership during drain, preserving accepted input and seeded requests through route resolution.
- Preserve native interrupted reasoning-only history in sidecar sessions so canceled first replies can be retried without the legacy-import guard rejecting them.
- Explain missing model output-token caps as a configuration issue instead of incorrectly reporting a full context.
- Add explicit read-only client RPC retry; never replay an uncertain switch write and reject stale session responses.
- Require pinned installed DSH for the full test gate, fail on skips, and provide an explicitly limited portable suite plus pinned-host CI.
- Convert the fixed teardown defect into a positive host regression and retain labeled late-enqueue/legacy-removal boundary tests.
- Document actual Web protocol checks and three limited live OFF/ON pairs, preserving transport uncertainty and avoiding quality, capability, or efficiency claims.
- **Still experimental:** hot unload is not atomic with host input admission. Stop all submissions, drain work and shut down DSH before updates/removal. No claim of improved model capability or answer quality.

## 0.2.0-experimental.13

- Added an experimental per-session switch that follows the selected DSH provider and model.
- Projects an authorized example into the first turn without writing the new session's example messages to its event history.
- Supports the tested OpenAI Chat Completions and DSH DeepSeek Messages mappings; other protocols may be unsupported.
- Publishes an authorized example, documented compatibility and limitations, and a curated synthetic test suite.
- **Known issue:** concurrent disable, reload, update, or removal can lose a claimed but uncommitted message or allow a request without the example. Earlier sessions with legacy references have additional migration limitations. Read the README before installation or maintenance.

Earlier development, experiments and validation boundaries are summarized in [the development record](docs/DEVELOPMENT.zh-CN.md).
