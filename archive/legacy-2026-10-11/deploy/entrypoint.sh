#!/usr/bin/env sh
set -eu

mkdir -p "${AUDIT_RULES_DIR:-/app/runtime/rules}" /app/runtime/logs /app/runtime/tmp

# The reviewed seed is reproducible source data. Initialize an empty runtime
# volume without baking generated, mutable rule snapshots into the image.
seed_target="${AUDIT_RULES_DIR:-/app/runtime/rules}/published/rules-IS-schengen-tourism.json"
if [ ! -f "$seed_target" ]; then
  python /app/tools/rules/bootstrap_general.py --store "${AUDIT_RULES_DIR:-/app/runtime/rules}"
fi

exec "$@"
