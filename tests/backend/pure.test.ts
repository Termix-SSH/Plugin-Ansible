import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildInventory } from "../../src/backend/inventory.js";
import {
  parseFacts,
  parseFiles,
  parseRawRuns,
  parseRecap,
  summarize,
} from "../../src/backend/parse.js";
import {
  cancelScript,
  cleanRelPath,
  deleteFileScript,
  filesScript,
  launchScript,
  listRunsScript,
  readFileScript,
  removeRunScript,
  runDetailScript,
  statusScript,
  writeFileScript,
} from "../../src/backend/scripts.js";
import { parseExtraVars } from "../../src/backend/service.js";

function bashOk(script: string): boolean {
  return spawnSync("bash", ["-n"], { input: script }).status === 0;
}

describe("cleanRelPath", () => {
  it("accepts project files", () => {
    expect(cleanRelPath("site.yml")).toBe("site.yml");
    expect(cleanRelPath("./roles/web/tasks/main.yaml")).toBe(
      "roles/web/tasks/main.yaml",
    );
  });

  it("refuses escapes and odd names", () => {
    for (const bad of [
      "../x.yml",
      "/etc/passwd.yml",
      "a/../b.yml",
      "-x.yml",
      "a b.yml",
      "a;b.yml",
      ".git/config.yml",
      "script.sh",
      "",
      5,
    ]) {
      expect(cleanRelPath(bad)).toBeNull();
    }
  });
});

describe("scripts", () => {
  it("are valid bash", () => {
    const uid = "1700000000000-abcdef";
    const scripts = [
      statusScript("~/ansible"),
      filesScript("~/ansible"),
      readFileScript("~/ansible", "site.yml"),
      writeFileScript("~/ansible", "site.yml", "- hosts: all\n", true),
      deleteFileScript("~/ansible", "site.yml"),
      listRunsScript(),
      runDetailScript(uid, 1000),
      cancelScript(uid),
      removeRunScript(uid),
      launchScript({
        uid,
        dir: "~/ansible",
        command: "ansible-playbook",
        args: "-i \"$D/secret/inventory.json\" 'site.yml'",
        meta: "{}",
        inventory: "{}",
        vars: "{}",
        keys: { h1: "KEY" },
        looseHostKeys: true,
        vaultFile: "~/.vault",
      }),
    ];
    for (const script of scripts) expect(bashOk(script)).toBe(true);
  });

  it("keeps the project folder quoted", () => {
    expect(statusScript("~/my dir")).toContain("P='~/my dir'");
  });

  it("switches to a UTF-8 locale, since Ansible refuses LC_ALL=C", () => {
    expect(statusScript("~/ansible")).toContain('export LC_ALL="$L" LANG="$L"');
  });
});

describe("inventory", () => {
  it("builds groups, aliases and secrets", () => {
    const inv = buildInventory([
      {
        id: 2,
        name: "Web 1",
        ip: "10.0.0.2",
        port: 22,
        username: "root",
        folder: "Servers/Web",
        tags: ["prod"],
        key: "KEY",
        sudoPassword: "s",
        local: false,
      },
      {
        id: 3,
        name: "Web 1",
        ip: "10.0.0.3",
        port: 2222,
        username: "bob",
        folder: "",
        tags: [],
        password: "pw",
        local: false,
      },
      {
        id: 1,
        name: "control",
        ip: "10.0.0.1",
        port: 22,
        username: "root",
        folder: "",
        tags: [],
        local: true,
      },
    ]);
    const data = JSON.parse(inv.json).all;
    expect(Object.keys(data.hosts)).toEqual(["web-1", "web-1-3", "control"]);
    expect(data.hosts["web-1"].ansible_ssh_private_key_file).toBe(
      "@@D@@/secret/keys/h2",
    );
    expect(data.hosts["web-1"].ansible_become_password).toBe("s");
    expect(data.hosts["web-1-3"].ansible_password).toBe("pw");
    expect(data.hosts["web-1-3"].ansible_port).toBe(2222);
    expect(data.hosts.control).toEqual({ ansible_connection: "local" });
    expect(Object.keys(data.children).sort()).toEqual([
      "folder_servers",
      "folder_servers_web",
      "tag_prod",
      "termix",
    ]);
    expect(inv.keys).toEqual({ h2: "KEY" });
  });

  it("skips keys with a passphrase", () => {
    const inv = buildInventory([
      {
        id: 4,
        name: "a",
        ip: "1.1.1.1",
        port: 22,
        username: "r",
        folder: "",
        tags: [],
        key: "K",
        keyPassword: "p",
        local: false,
      },
    ]);
    expect(inv.skipped).toEqual([{ id: 4, reason: "keyPassphrase" }]);
    expect(JSON.parse(inv.json).all.hosts).toEqual({});
  });
});

describe("extra vars", () => {
  it("types values", () => {
    expect(parseExtraVars("a=1\nb=true\n# note\nc=x y")).toEqual({
      a: 1,
      b: true,
      c: "x y",
    });
  });

  it("refuses bad lines", () => {
    expect(() => parseExtraVars("nope")).toThrow();
    expect(() => parseExtraVars("1a=2")).toThrow();
  });
});

describe("parsers", () => {
  it("reads the file list", () => {
    expect(parseFiles("F\tsite.yml\t120\t1700000000\t1\nnoise\n")).toEqual([
      { path: "site.yml", size: 120, modified: 1700000000000, playbook: true },
    ]);
  });

  const meta = {
    id: "1700000000000-abcdef",
    kind: "playbook",
    title: "site.yml",
    command: "ansible-playbook site.yml",
    startedAt: 1700000000000,
    startedBy: "u1",
    check: false,
    hosts: [],
  };

  it("works out run states", () => {
    const now = 1700000000 + 600;
    const run = (extra: string) =>
      parseRawRuns(`@@run\n${JSON.stringify(meta)}\n${extra}`)[0]!;
    expect(summarize(run("@@alive\n"), now)?.state).toBe("running");
    expect(summarize(run("@@result\n0 1700000100\n"), now)?.state).toBe("ok");
    expect(summarize(run("@@result\n2 1700000100\n"), now)?.state).toBe(
      "failed",
    );
    expect(summarize(run("@@cancelled\n"), now)?.state).toBe("cancelled");
    expect(summarize(run(""), now)?.state).toBe("lost");
    expect(summarize(run(""), 1700000005)?.state).toBe("running");
  });

  it("keeps the whole log of a detail answer", () => {
    const raw = parseRawRuns(
      `@@run\n${JSON.stringify(meta)}\n@@result\n0 1700000100\n@@size\n12\n@@log\nPLAY [a]\n@@not a marker\n`,
    )[0]!;
    expect(raw.size).toBe(12);
    expect(raw.log).toContain("@@not a marker");
  });

  it("reads the recap", () => {
    const log = `PLAY RECAP *****
web1 : ok=3 changed=1 unreachable=0 failed=0 skipped=2 rescued=0 ignored=0
db1  : ok=1 changed=0 unreachable=1 failed=0
`;
    expect(parseRecap(log)).toEqual([
      {
        host: "web1",
        ok: 3,
        changed: 1,
        unreachable: 0,
        failed: 0,
        skipped: 2,
      },
      { host: "db1", ok: 1, changed: 0, unreachable: 1, failed: 0, skipped: 0 },
    ]);
  });

  it("reads facts blocks", () => {
    const log = `web1 | SUCCESS => {
    "ansible_facts": {
        "ansible_kernel": "6.1"
    },
    "changed": false
}
db1 | UNREACHABLE! => {
    "msg": "no route"
}
`;
    const hosts = parseFacts(log);
    expect(hosts[0]).toMatchObject({
      host: "web1",
      ok: true,
      facts: { ansible_kernel: "6.1" },
    });
    expect(hosts[1]).toMatchObject({
      host: "db1",
      ok: false,
      message: "no route",
    });
  });
});
