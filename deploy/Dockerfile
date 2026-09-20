# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS claude

ARG CLAUDE_CODE_VERSION=2.1.201
RUN npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    LOG_FILE=/app/runtime/logs/backend.log \
    AUDIT_RULES_DIR=/app/runtime/rules \
    AGENT_PROVIDER=claude \
    CLAUDE_CLI_PATH=/usr/local/bin/claude \
    CLAUDE_SETTINGS_FILE=/app/deploy/claude.settings.container.json \
    CLAUDE_REQUIRE_AUTH_TOKEN=1 \
    AGENT_MODEL=sonnet \
    AGENT_TIMEOUT_SECONDS=300

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates poppler-utils tini \
    && rm -rf /var/lib/apt/lists/* \
    && python -m venv /opt/venv

COPY --from=claude /usr/local/bin/node /usr/local/bin/node
COPY --from=claude /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js /usr/local/bin/claude

WORKDIR /app
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir --requirement /app/backend/requirements.txt

COPY backend /app/backend
COPY tools /app/tools
COPY data/checklists /app/data/checklists
COPY data/rules/bootstrap /app/data/rules/bootstrap
COPY deploy /app/deploy

RUN useradd --create-home --uid 10001 visahelper \
    && mkdir -p /app/runtime/logs /app/runtime/rules /app/runtime/tmp \
    && chown -R visahelper:visahelper /app/runtime \
    && chmod +x /app/deploy/entrypoint.sh /app/deploy/tencent-tcr.sh

USER visahelper
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/entrypoint.sh"]
CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000"]
