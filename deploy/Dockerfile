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
    AGENT_MODEL=MiniMax-M3 \
    AGENT_TIMEOUT_SECONDS=300

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates poppler-utils tini \
    && rm -rf /var/lib/apt/lists/* \
    && python -m venv /opt/venv

COPY --from=claude /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe /usr/local/bin/claude

WORKDIR /app
COPY backend/requirements.txt /opt/visa-helper-requirements.txt
RUN pip install --no-cache-dir --requirement /opt/visa-helper-requirements.txt

# Application code and Claude policy are read-only bind mounts at runtime.
# Only the dependency environment and startup helper belong in the image.
COPY deploy/entrypoint.sh /usr/local/bin/visa-helper-entrypoint

RUN useradd --create-home --uid 10001 visahelper \
    && mkdir -p /app/backend /app/tools /app/data/checklists /app/data/rules/bootstrap \
        /app/deploy /app/runtime/logs /app/runtime/rules /app/runtime/tmp \
    && chown -R visahelper:visahelper /app/runtime \
    && chmod +x /usr/local/bin/visa-helper-entrypoint

USER visahelper
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/visa-helper-entrypoint"]
CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000"]
