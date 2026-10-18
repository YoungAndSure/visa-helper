#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release_root="${1:-$app_dir/.local/releases}"
node_image="${NODE_IMAGE:-node:22-alpine}"

# Resolve the actual runtime fingerprint before building; requires npm ci on the build machine.
read -r app_version app_build_hash < <(
  cd "$app_dir"
  node --input-type=module -e 'import { createVisaServer } from "./src/server.js"; const info = createVisaServer().releaseInfo(); console.log(info.version, info.buildHash);'
)
image_tag="visa-helper-mcp:$app_version-${app_build_hash:0:12}"
release_dir="$release_root/$app_version-${app_build_hash:0:12}"
mkdir -p "$release_dir"
release_dir="$(cd "$release_dir" && pwd)"

# Record and build from the resolved base digest so this bundle identifies its exact base.
docker pull --platform linux/amd64 "$node_image"
node_image="$(docker image inspect --format '{{index .RepoDigests 0}}' "$node_image")"
docker build --platform linux/amd64 --build-arg "NODE_IMAGE=$node_image" \
  --build-arg "APP_VERSION=$app_version" --build-arg "APP_BUILD_HASH=$app_build_hash" \
  --tag "$image_tag" "$app_dir"
# Check rules and XState inside the image without network or application data.
docker run --rm --network none "$image_tag" node --input-type=module -e '
  import { createVisaServer } from "./src/server.js";
  const info = createVisaServer().releaseInfo();
  if (info.buildHash !== process.argv[1] || info.rules.engine !== "xstate" || !info.tools.includes("advance_task") || info.tools.length !== 6) process.exit(1);
  console.log(JSON.stringify({ version: info.version, build: info.buildHash, tools: info.tools.length, engine: info.rules.engine }));
' "$app_build_hash"

docker image save "$image_tag" | gzip > "$release_dir/image.tar.gz.tmp"
mv "$release_dir/image.tar.gz.tmp" "$release_dir/image.tar.gz"
cp "$app_dir/deploy/compose.yml" "$release_dir/compose.yml"
printf 'VISA_HELPER_IMAGE=%s\nVISA_HELPER_PULL_POLICY=never\n' "$image_tag" > "$release_dir/runtime.env"
image_id="$(docker image inspect --format '{{.Id}}' "$image_tag")"
node --input-type=module - "$release_dir/release.json" "$image_tag" "$image_id" "$app_build_hash" "$node_image" <<'JS'
import { writeFileSync } from 'node:fs';
const [path, image, imageId, buildHash, baseImage] = process.argv.slice(2);
writeFileSync(path, JSON.stringify({ image, imageId, buildHash, baseImage }, null, 2) + '\n');
JS
(
  cd "$release_dir"
  sha256sum image.tar.gz compose.yml runtime.env release.json > SHA256SUMS
)
printf '\nRelease bundle: %s\nImage: %s\n' "$release_dir" "$image_tag"
