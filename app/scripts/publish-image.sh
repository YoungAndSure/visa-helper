#!/usr/bin/env bash
set -euo pipefail

source_image="${1:?Usage: publish-image.sh LOCAL_IMAGE [REGISTRY_REPOSITORY] [OUTPUT_ENV_FILE]}"
repository="${2:-ccr.ccs.tencentyun.com/visa-helper/visa-helper}"
publish_env_file="${3:-}"
if [[ "$source_image" == -* || "$source_image" != *:* || "$source_image" == *@* || "$repository" == -* || "$repository" == *://* || "$repository" == *@* ]]; then
  printf 'Provide a tagged local image and a registry repository without a URL scheme or digest.\n' >&2
  exit 2
fi

# Reuse the verified image; tagging and pushing do not rebuild or read application data.
source_id="$(docker image inspect --format '{{.Id}}' "$source_image")"
target_image="$repository:${source_image##*:}"
docker image tag "$source_image" "$target_image"
docker image push "$target_image"
published_ref=''
while IFS= read -r candidate; do
  if [[ "$candidate" == "$repository"@sha256:* ]]; then
    published_ref="$candidate"
    break
  fi
done < <(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$target_image")
if [[ -z "$published_ref" ]]; then
  printf 'Push returned without a repository digest; verify the registry before deploying.\n' >&2
  exit 1
fi
if [[ "$(docker image inspect --format '{{.Id}}' "$target_image")" != "$source_id" ]]; then
  printf 'The tagged image changed during publication; do not deploy it.\n' >&2
  exit 1
fi
if [[ -n "$publish_env_file" ]]; then
  mkdir -p "$(dirname "$publish_env_file")"
  printf 'VISA_HELPER_IMAGE=%s\nVISA_HELPER_PULL_POLICY=missing\n' "$published_ref" > "$publish_env_file"
fi
printf '\nPublished tag: %s\nPinned reference: %s\n' "$target_image" "$published_ref"
