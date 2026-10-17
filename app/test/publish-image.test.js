import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const exec = promisify(execFile);
test("registry publication pins the pushed digest and never reports failed pushes as published", async () => {
  const root = await mkdtemp(join(tmpdir(), "visa-helper-publish-"));
  const bin = join(root, "bin"); await mkdir(bin);
  await writeFile(join(bin, "docker"), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$PUBLISH_TEST_LOG"
case "$1 $2" in
  'image inspect')
    if [[ "$*" == *RepoDigests* ]]; then
      printf 'ccr.ccs.tencentyun.com/visa-helper/visa-helper@sha256:abc123\\n'
    else printf 'sha256:verified-image\\n'; fi ;;
  'image tag') : ;;
  'image push') [[ "\${PUBLISH_TEST_FAIL:-0}" == 0 ]] || exit 1 ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  const script = new URL("../scripts/publish-image.sh", import.meta.url).pathname;
  const repo = "ccr.ccs.tencentyun.com/visa-helper/visa-helper";
  const log = join(root, "calls");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PUBLISH_TEST_LOG: log };
  const output = join(root, "registry.env");
  await exec("bash", [script, "visa-helper-mcp:0.7.0-build", repo, output], { env });
  assert.equal(await readFile(output, "utf8"), `VISA_HELPER_IMAGE=${repo}@sha256:abc123\nVISA_HELPER_PULL_POLICY=missing\n`);
  assert.match(await readFile(log, "utf8"), /image push ccr\.ccs\.tencentyun\.com\/visa-helper\/visa-helper:0\.7\.0-build/);
  const failedOutput = join(root, "failed.env");
  await assert.rejects(exec("bash", [script, "visa-helper-mcp:0.7.0-build", repo, failedOutput], { env: { ...env, PUBLISH_TEST_FAIL: "1" } }));
  await assert.rejects(readFile(failedOutput), { code: "ENOENT" });
  await assert.rejects(exec("bash", [script, "visa-helper-mcp:0.7.0-build", "https://wrong.example/repo"], { env }));
});
