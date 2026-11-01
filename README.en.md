# dsh-style-seed · an experimental weneed switch

[中文说明](README.md) · [Development and validation history (中文)](docs/DEVELOPMENT.zh-CN.md)

An experimental per-session switch for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI. When enabled for a new session, the plugin temporarily inserts an authorized example conversation and reasoning into the first turn. It aims to encourage task-focused English reasoning, sometimes beginning with “We need”. It follows the selected DSH provider and model rather than hard-coding one endpoint.

The project owner observed better answers in some personal use. This is a subjective observation, not a controlled finding: the plugin does not guarantee a particular phrase, higher answer quality, stronger capability, or lower cost.

> **Experimental; do not disable, reload, update, or uninstall while requests may be running or queued.** Release `.14` fixes the reproduced loss of accepted input during route-resolution teardown. A remaining race can still let an enabled session send a request without its sample if input arrives after the final idle snapshot. Stop submissions from all clients, wait for active and queued work, and shut down the DSH service before maintenance. Earlier sessions containing a legacy reference also require separate migration or a new session; stopping the service does not migrate them.

## Why this plugin exists

The project began with the owner's observation in one conversation: after using Kimi K3.1 PRO, they switched the same conversation to DeepSeek V4.1 Flash and saw it carry forward a natural, task-focused style of English reasoning. They found that style similar to what they had experienced in DeepSeek's minimal mode. This led to experiments with conversation examples and, eventually, this DSH plugin. The comparison with minimal mode is a personal observation; the two approaches have not been directly compared in a controlled study, and a shared internal mechanism has not been established.

“We need” is one possible expression of that style, not a required opening for every reasoning segment. The aim is direct task analysis with less repetitive self-reference such as “Let me”. The plugin supplies an example conversation and reasoning as context; **it does not add a prompt instructing the model to begin with “We need”**, nor does it ban “Let me”. The model's wording depends on the task and context.

In an earlier experiment using the same sample content as the public example, 14 of 20 main response segments from four sessions began with “We need”, with zero occurrences of “Let me”. The segments include tool continuations and are not 20 independent sessions. This used a test-only hook rather than a direct measurement of release `.13`; the control group's incomplete sessions and other limitations are described in the [development record (中文)](docs/DEVELOPMENT.zh-CN.md).

## Scope

- Tested host target: DSH `0.2.2-alpha.2`, Web; Node.js `>=24.9.0`.
- The switch is off by default. Enable it before the first message; once a started session has been turned off, start a new session to turn it on again.
- The sample is included in first-turn requests and necessary tool continuations until the first successful reply. It is not inserted into the new session's event history. The first actual answer can still carry sample influence into later turns.
- OpenAI Chat Completions and the official DSH DeepSeek Messages mapping are implemented. Other protocols may be rejected. Image and tool handling have synthetic coverage; one d1api configuration has a single real-network test. Other providers and daily Electron desktop use have not been validated.
- The provided [example](examples/we-need-seed.json) was approved for publication. Its source metadata is redacted. The example is sent to the selected model service when the switch is enabled.

## Install for isolated testing

Back up your data and stop the relevant DSH service before adding or changing the plugin. `web` below is an example profile; do not apply it to a valuable profile without preparation.

```bash
git clone https://github.com/bartholo4/dsh-style-seed.git
cd dsh-style-seed
dsh plugin --profile web add .
```

Configure the existing `dsh-style-seed` row using the DSH settings interface or the profile's `cordis.patch.yml`; replace the path with an absolute path on your machine:

```yaml
- id: dsh-style-seed
  config:
    enabled: true
    followSelected: true
    seedPath: "/absolute/path/to/dsh-style-seed/examples/we-need-seed.json"
```

If the row already exists, edit it rather than adding a duplicate. Restart the stopped Web profile, create a new session, choose a model, and enable the session switch. This project is distributed as a GitHub source repository; it has not been published to npm.

Before publication, the official DSH 0.2.2-alpha.2 CLI installed a linked local source snapshot offline in an isolated profile, and Web started to ready with a synthetic sample. That check did not cover an end-to-end browser, RPC, or model conversation.

## Validation and limitations

An earlier `.5` fixed-model experiment using a longer, different sample observed “We need” at the start of 8/8 enabled versus 3/8 disabled first responses, with 0 versus 9 total occurrences of “Let me”, respectively. That small study measured style, not answer quality, and does not establish the current shorter sample's effectiveness. The original `.13` candidate had 137 internal synthetic checks and one real d1api synthetic request. The public tests are a curated subset, not a reproduction of all 137; 123 regression tests passed with the stated DSH runtime. Those are historical counts, not the current release gate. Lifecycle coverage now includes positive accepted-input drain regressions and explicitly labeled remaining boundary characterizations, not proof of safe hot unload.

The sample can affect factual context: in an earlier test, an ambiguous self-check treated the sample's puzzle as part of the real conversation. Other providers, long sessions, the Electron desktop, and full migration/rollback remain unverified. See the Chinese README and [development record](docs/DEVELOPMENT.zh-CN.md) before use.

## License

The code and example dialogue/reasoning excerpts approved for publication by their provider are offered under the [MIT license](LICENSE); identifying provenance is omitted. Dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

## Reproducible development checks

```bash
# Install the official pinned DSH into a separate disposable directory.
npm install --prefix /tmp/dsh-test-runtime @deepseek-ai/dsh@0.2.2-alpha.2
export DSH_RUNTIME_NODE_MODULES=/tmp/dsh-test-runtime/node_modules
npm run check
```

The `.14` cloud check on Node `24.22.1` with installed DSH `0.2.2-alpha.2` passed **140 tests, zero skips**. This includes actual host services and gateway RPC with synthetic model responses, plus deterministic client component/source-bundle fixtures; it is not a real-browser end-to-end or paid-model evaluation.

`npm test` requires the supported installed host and fails on skipped tests. `npm run test:portable` explicitly runs limited coverage without host integration; it is not the release gate. `npm run test:lifecycle` isolates lifecycle tests (set the same runtime variable). Tests use synthetic data and blocked model-network access. `npm run build:client` regenerates the dependency-free client bundle; `check:client` verifies it matches source. There is no separate TypeScript or lint toolchain in this JavaScript-only repository.

The `.14` switch shows an explicit status retry after an RPC failure. Retry only reads server state: it never resends an uncertain write. Session and generation guards discard stale responses.
