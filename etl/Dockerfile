FROM python:3.12-slim

# procps (pgrep) backs docker-compose.yml's healthcheck — task 1.6, #14
# review noted the etl service had no healthcheck at all, unlike the other
# 3 services, so a crashed/exited process was indistinguishable from a
# healthy one in `docker compose ps`.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libffi-dev procps && \
    rm -rf /var/lib/apt/lists/*

# Copy into /app/etl/ so the package is importable as "etl.*"
# (main.py and the rest of etl/ share the same package namespace)
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && \
    opentelemetry-bootstrap -a install
COPY . etl/

CMD ["opentelemetry-instrument", "python", "-u", "-m", "etl.main"]
