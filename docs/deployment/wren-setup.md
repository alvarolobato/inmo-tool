# WrenAI Setup

WrenAI provides a text-to-SQL web interface over the PostgreSQL mirror.

## Access the UI

Open [http://localhost:3000](http://localhost:3000) (or `http://localhost:<HOST_PORT>` if you changed `HOST_PORT` in `.env`).

Allow 1–2 minutes after `ps-analytics up` for all services to initialise. If the page is blank, check [troubleshooting.md](troubleshooting.md#wrenai-ui-blank-or-loading).

## Configure the data source

On first launch WrenAI asks you to set up a data source. Select **PostgreSQL** and enter:

| Field | Value |
|-------|-------|
| Host | `postgres` |
| Port | `5432` |
| Database | `powershop` (or the value of `POSTGRES_DB` in `.env`) |
| Username | `postgres` (or `POSTGRES_USER`) |
| Password | the value of `POSTGRES_PASSWORD` in `.env` |

The host `postgres` is the container name on the internal Docker network — do not use `localhost`.

Once connected, WrenAI will discover the available tables (all `ps_*` tables created by the ETL).

## LLM configuration

The LLM is configured entirely via `.env` — no UI changes needed.

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENROUTER_API_KEY` | *(required)* | OpenRouter API key |
| `WREN_LLM_MODEL` | `openrouter/anthropic/claude-sonnet-4-20250514` | Model for SQL generation |

To change the model, edit `.env` and restart the AI services:

```bash
# Edit .env: change WREN_LLM_MODEL=openrouter/<provider>/<model>
ps-analytics restart
```

Any model available on [OpenRouter](https://openrouter.ai/models) can be used. Recommended options:

| Model | OpenRouter identifier |
|-------|-----------------------|
| Claude Sonnet 4 (default) | `openrouter/anthropic/claude-sonnet-4-20250514` |
| Claude Opus 4 | `openrouter/anthropic/claude-opus-4-5` |
| GPT-4o | `openrouter/openai/gpt-4o` |

The embedder model (`openrouter/openai/text-embedding-3-large`) is configured in `wren-config.yaml` and requires a separate OpenRouter quota.

## Test with a natural language query

Once data is loaded (run `ps-analytics etl run` if you haven't yet), try a question in the WrenAI UI:

> "How many sales were there last month?"

> "Show me the top 10 products by revenue this year."

WrenAI generates SQL, executes it against PostgreSQL, and returns the result.

## Customising wren-config.yaml

Advanced LLM and pipeline settings are in `wren-config.yaml` in the project directory (`~/.powershop-analytics/wren-config.yaml` on Linux/macOS).

Key sections:

- **`type: llm`** — LLM model alias, context window, temperature, max tokens
- **`type: embedder`** — embedding model for vector search
- **`type: document_store`** — Qdrant connection and index settings
- **`settings`** — timeouts, batch sizes, SQL correction retries, caching

After editing `wren-config.yaml`, restart the AI service:

```bash
ps-analytics restart
```

The config file is bind-mounted read-only into the `wren-ai-service` container; changes take effect on restart.
