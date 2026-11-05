import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseFiles,
  parseRawRuns,
  summarize,
} from "../../src/backend/parse.js";
import {
  cancelScript,
  filesScript,
  launchScript,
  listRunsScript,
  readFileScript,
  runDetailScript,
  writeFileScript,
} from "../../src/backend/scripts.js";

const slash = (path: string) => path.split("\\").join("/");
const home = slash(mkdtempSync(join(tmpdir(), "ansible-test-")));
const bin = `${home}/.local/bin`;
mkdirSync(bin, { recursive: true });

// A fake ansible that prints its arguments and a recap, and fails a syntax
// check when the file says BAD.
const fake = `#!/bin/bash
for a in "$@"; do
  if [ "$a" = "--syntax-check" ]; then
    f="\${@: -1}"
    grep -q BAD "$f" && { echo "ERROR! bad yaml"; echo "line two"; exit 4; }
    exit 0
  fi
done
echo "ARGS: $*"
echo "PLAY RECAP *****"
echo "web1 : ok=2 changed=1 unreachable=0 failed=0 skipped=0"
`;
for (const name of ["ansible-playbook", "ansible"]) {
  writeFileSync(`${bin}/${name}`, fake);
  chmodSync(`${bin}/${name}`, 0o755);
}

function sh(script: string) {
  const r = spawnSync("bash", ["-s"], {
    input: script,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

const dir = "~/proj";

describe("scripts on a real shell", () => {
  it("saves, reads and lists files, with a syntax check", () => {
    expect(
      sh(writeFileScript(dir, "site.yml", "- hosts: all\n", true)).code,
    ).toBe(0);
    expect(
      sh(writeFileScript(dir, "roles/a/vars.yml", "a: 1\n", false)).code,
    ).toBe(0);
    expect(sh(readFileScript(dir, "site.yml")).out).toBe("- hosts: all\n");

    const bad = sh(writeFileScript(dir, "bad.yml", "- hosts: BAD\n", true));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("SCRIPT_ERR:ERROR! bad yaml");
    expect(bad.out).toContain("SCRIPT_ERR:line two");
    expect(sh(readFileScript(dir, "bad.yml")).code).toBe(1);

    const files = parseFiles(sh(filesScript(dir)).out);
    expect(files.map((f) => [f.path, f.playbook])).toEqual([
      ["roles/a/vars.yml", false],
      ["site.yml", true],
    ]);
  });

  it("will not leave the project through a symlink", () => {
    writeFileSync(`${home}/secret.yml`, "x: 1\n");
    const link = spawnSync("ln", [
      "-s",
      `${home}/secret.yml`,
      `${home}/proj/link.yml`,
    ]);
    // Git Bash on Windows copies instead of linking without symlink rights.
    const real = spawnSync("test", ["-L", `${home}/proj/link.yml`]);
    if (link.status !== 0 || real.status !== 0) return;
    const r = sh(readFileScript(dir, "link.yml"));
    expect(r.code).toBe(1);
    expect(r.out).toContain("outside the project folder");
  });

  it("launches a run, lists it and reads its detail", async () => {
    const uid = "1700000000000-abcdef";
    const launch = sh(
      launchScript({
        uid,
        dir,
        command: "ansible-playbook",
        args: "-i \"$D/secret/inventory.json\" 'site.yml'",
        meta: JSON.stringify({
          id: uid,
          kind: "playbook",
          title: "site.yml",
          command: "ansible-playbook site.yml",
          startedAt: Date.now(),
          startedBy: "u",
          check: false,
          hosts: [],
        }),
        inventory:
          '{"all":{"hosts":{"a":{"ansible_ssh_private_key_file":"@@D@@/secret/keys/h1"}}}}',
        vars: "{}",
        keys: { h1: "KEY" },
        looseHostKeys: true,
        vaultFile: "",
      }),
    );
    expect(launch.out).toContain("started");

    let state = "";
    for (let i = 0; i < 40 && state !== "ok"; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const raw = parseRawRuns(sh(listRunsScript()).out)[0];
      state = raw ? (summarize(raw, Date.now() / 1000)?.state ?? "") : "";
    }
    expect(state).toBe("ok");

    const detail = parseRawRuns(sh(runDetailScript(uid, 10000)).out)[0]!;
    expect(detail.log).toContain("ARGS: -i");
    expect(detail.log).toContain("PLAY RECAP");

    // Secrets are gone once the run ends.
    const left = sh(`ls "$HOME/.termix-ansible/runs/${uid}"`);
    expect(left.out).not.toContain("secret");
    expect(sh(cancelScript(uid)).out).toContain("done");
  });
});
