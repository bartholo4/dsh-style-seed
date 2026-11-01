# Changelog

## 0.2.0-experimental.14

- Separate switch-edit admission from live agent ownership during drain, preserving accepted input and seeded requests through route resolution.
- Add explicit read-only client RPC retry; never replay an uncertain switch write and reject stale session responses.
- Require pinned installed DSH for the full test gate, fail on skips, and provide an explicitly limited portable suite plus pinned-host CI.
- Convert the fixed teardown defect into a positive host regression and retain labeled late-enqueue/legacy-removal boundary tests.
- **Still experimental:** hot unload is not atomic with host input admission. Stop all submissions, drain work and shut down DSH before updates/removal. No claim of improved model capability or answer quality.

## 0.2.0-experimental.13

- Added an experimental per-session switch that follows the selected DSH provider and model.
- Projects an authorized example into the first turn without writing the new session's example messages to its event history.
- Supports the tested OpenAI Chat Completions and DSH DeepSeek Messages mappings; other protocols may be unsupported.
- Publishes an authorized example, documented compatibility and limitations, and a curated synthetic test suite.
- **Known issue:** concurrent disable, reload, update, or removal can lose a claimed but uncommitted message or allow a request without the example. Earlier sessions with legacy references have additional migration limitations. Read the README before installation or maintenance.

Earlier development, experiments and validation boundaries are summarized in [the development record](docs/DEVELOPMENT.zh-CN.md).
