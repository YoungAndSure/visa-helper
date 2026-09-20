#!/usr/bin/env bash
set -euo pipefail

action="${1:-build}"
registry="${TCR_REGISTRY:-ccr.ccs.tencentyun.com}"
namespace="${TCR_NAMESPACE:-}"
repository="${TCR_REPOSITORY:-visa-helper}"
platform="${IMAGE_PLATFORM:-linux/amd64}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not available in PATH." >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
tag="${IMAGE_TAG:-$(git -C "$repo_root" rev-parse --short=12 HEAD)}"
local_image="visa-helper:${tag}"

docker build --platform "$platform" --file "$repo_root/deploy/Dockerfile" --tag "$local_image" "$repo_root"

if [[ "$action" == "build" ]]; then
  echo "Built ${local_image} (${platform})"
  exit 0
fi

if [[ "$action" != "push" ]]; then
  echo "Usage: TCR_NAMESPACE=<namespace> $0 [build|push]" >&2
  exit 2
fi
if [[ -z "$namespace" ]]; then
  echo "TCR_NAMESPACE is required for push." >&2
  exit 2
fi
if ! [[ "$namespace" =~ ^[a-z0-9][a-z0-9._-]{1,59}$ ]]; then
  echo "TCR_NAMESPACE contains unsupported characters." >&2
  exit 2
fi
if ! [[ "$repository" =~ ^[a-z0-9][a-z0-9._/-]{0,126}$ ]]; then
  echo "TCR_REPOSITORY contains unsupported characters." >&2
  exit 2
fi

remote_image="${registry}/${namespace}/${repository}:${tag}"
docker image tag "$local_image" "$remote_image"
docker image push "$remote_image"
echo "Pushed ${remote_image}"
