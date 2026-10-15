import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const exec = promisify(execFile);

test("background test service reads the key privately, avoids duplicates, and cleans up its children", async () => {
  const root = await mkdtemp(join(tmpdir(), "visa-helper-background-"));
  const local = join(root, ".local");
  const bin = join(root, "bin");
  await mkdir(join(local, "tunnel-profiles"), { recursive: true });
  await mkdir(join(root, "scripts"));
  await mkdir(bin);
  const script = join(root, "scripts/start-private-test.sh");
  await copyFile(new URL("../scripts/start-private-test.sh", import.meta.url), script);
  await writeFile(join(local, "known_hosts"), "test host key");
  await writeFile(join(local, "tunnel-profiles/visa-helper-test.yaml"), "test profile");
  const fakeKey = "test-secret-for-process-lifecycle-only";
  await writeFile(join(local, "tunnel.env"), `CONTROL_PLANE_API_KEY=${fakeKey}\n`, { mode: 0o600 });
  await writeFile(join(local, "tunnel-client"), `#!/usr/bin/env bash
set -eu
[[ "$CONTROL_PLANE_API_KEY" == '${fakeKey}' ]]
if [[ "$1" == doctor ]]; then echo 'CHECK test PASS'; exit; fi
touch "$TEST_STATE/ready"
trap 'rm -f "$TEST_STATE/ready"; exit 0' TERM INT
while true; do sleep 0.1; done
`, { mode: 0o700 });
  await writeFile(join(bin, "ssh"), `#!/usr/bin/env bash
touch "$TEST_STATE/ssh"
trap 'rm -f "$TEST_STATE/ssh"; exit 0' TERM INT
while true; do sleep 0.1; done
`, { mode: 0o700 });
  await writeFile(join(bin, "curl"), `#!/usr/bin/env bash
case "$*" in
  *18081*) [[ -f "$TEST_STATE/ssh" ]] || exit 1; printf 'Visa Helper MCP App prototype' ;;
  *8080*) [[ -f "$TEST_STATE/ready" ]] ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_STATE: root };
  delete env.CONTROL_PLANE_API_KEY;
  const run = (command) => exec("bash", [script, command], { env, timeout: 15000 });
  try {
    assert.match((await run("start")).stdout, /已在后台就绪/);
    const firstPid = await readFile(join(local, "private-test.pid"), "utf8");
    assert.match((await run("status")).stdout, /已就绪/);
    assert.match((await run("start")).stdout, /已在运行/);
    assert.equal(await readFile(join(local, "private-test.pid"), "utf8"), firstPid);
    const commandLine = await readFile(`/proc/${firstPid.trim()}/cmdline`, "utf8");
    assert.ok(!commandLine.includes(fakeKey));
    assert.ok(!(await readFile(join(local, "private-test.log"), "utf8")).includes(fakeKey));
  } finally {
    await run("stop");
  }
  assert.match((await run("status")).stdout, /未运行/);
  await assert.rejects(readFile(join(root, "ssh")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "ready")), { code: "ENOENT" });
});
