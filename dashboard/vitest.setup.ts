/**
 * Global test setup — runs before every test file.
 *
 * ## Isolation from the developer's real config
 *
 * `lib/system-config/loader.ts` resolves its config file to
 * `~/.config/inmo-tool/config.yaml` when `CONFIG_FILE` is unset. That is the
 * OPERATOR'S LIVE CONFIG on a developer machine, so without this the suite
 * silently reads whatever the machine happens to be configured to do, and the
 * result depends on whose laptop runs it.
 *
 * That is not theoretical. Two ways it has already bitten:
 *
 *  - A machine pinning `dashboard.llm_model_openrouter` made the "schema
 *    default" and "deprecated env fallback" cases in llm-model-config.test.ts
 *    assert against local config instead of the code under test.
 *  - Setting `dashboard.llm_enabled: false` on the host to actually turn the
 *    AI off (D-105) made 15 tests in llm-client.test.ts fail, because the
 *    kill switch fired inside the tests.
 *
 * Pointing `CONFIG_FILE` at a path that does not exist makes the loader fall
 * back to schema defaults, which is what unit tests should be testing. Tests
 * that need specific values still stub env vars (env beats file), and a test
 * that genuinely needs a config file can override `CONFIG_FILE` itself.
 */
process.env.CONFIG_FILE ??= "/nonexistent/inmo-tool-test-config/config.yaml";
