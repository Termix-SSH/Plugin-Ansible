import { afterEach, describe, expect, it } from "vitest";
import { startServer, type TestServer } from "./helpers";

let s: TestServer | null = null;

afterEach(async () => {
  await s?.close();
  s = null;
});

const STATUS = `user=deploy
dir=/home/deploy/ansible
installed=1
version=ansible [core 2.17.4]
project=1
sshpass=1
`;

const META = {
  id: "1700000000000-abcdef",
  kind: "playbook",
  title: "site.yml",
  command: "ansible-playbook site.yml",
  startedAt: 1700000000000,
  startedBy: "u1",
  check: true,
  hosts: [],
};

describe("status", () => {
  it("reports ansible and the project", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "installed=1", stdout: STATUS });
    const res = await s.request("GET", "/1/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      installed: true,
      version: "ansible [core 2.17.4]",
      projectExists: true,
      sshpass: true,
      canEdit: true,
    });
  });

  it("is refused when the plugin is off for the host", async () => {
    s = await startServer({ settings: { enableAnsible: false } });
    const res = await s.request("GET", "/1/status");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("disabled");
  });

  it("falls back to ~/ansible for a bad folder setting", async () => {
    s = await startServer({ settings: { projectDir: "/a/../b" } });
    await s.request("GET", "/1/status");
    expect(s.ssh.calls[0]!.stdin).toContain("P='~/ansible'");
  });
});

describe("files", () => {
  it("lists files for connect access", async () => {
    s = await startServer({ level: "connect" });
    s.ssh.replies.push({
      match: "find .",
      stdout: "F\tsite.yml\t10\t1700000000\t1\n",
    });
    const res = await s.request("GET", "/1/files");
    expect(res.body.files).toHaveLength(1);
  });

  it("needs edit access to read a file", async () => {
    s = await startServer({ level: "connect" });
    const res = await s.request("GET", "/1/file?path=site.yml");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("HOST_EDIT_REQUIRED");
  });

  it("reads a file", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "cat -- ", stdout: "- hosts: all\n" });
    const res = await s.request("GET", "/1/file?path=site.yml");
    expect(res.body).toEqual({ path: "site.yml", text: "- hosts: all\n" });
  });

  it("refuses paths outside the project", async () => {
    s = await startServer();
    for (const path of ["../x.yml", "/etc/x.yml", "a;b.yml", "x.sh"]) {
      const res = await s.request(
        "GET",
        `/1/file?path=${encodeURIComponent(path)}`,
      );
      expect(res.status).toBe(400);
    }
    expect(s.ssh.calls).toHaveLength(0);
  });

  it("checks a playbook before saving it", async () => {
    s = await startServer();
    await s.request("PUT", "/1/file", {
      path: "site.yml",
      text: "- hosts: all\n  tasks: []\n",
    });
    const script = s.ssh.calls[0]!.stdin;
    expect(script).toContain("--syntax-check");
    expect(script).toContain("mv -f");
  });

  it("skips the check for other files", async () => {
    s = await startServer();
    await s.request("PUT", "/1/file", { path: "vars/a.yml", text: "a: 1\n" });
    expect(s.ssh.calls[0]!.stdin).not.toContain("--syntax-check");
  });

  it("shows why a save failed", async () => {
    s = await startServer();
    s.ssh.replies.push({
      match: "--syntax-check",
      stdout: "SCRIPT_ERR:ERROR! bad yaml\n",
      code: 1,
    });
    const res = await s.request("PUT", "/1/file", {
      path: "site.yml",
      text: "- hosts: all\n",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("bad yaml");
  });

  it("blocks writes on a read only host", async () => {
    s = await startServer({ settings: { readOnly: true } });
    const res = await s.request("PUT", "/1/file", {
      path: "a.yml",
      text: "a: 1",
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("readOnly");
  });
});

describe("runs", () => {
  it("starts a playbook on the project inventory", async () => {
    s = await startServer();
    const res = await s.request("POST", "/1/runs", {
      kind: "playbook",
      playbook: "site.yml",
      check: true,
      limit: "web,!db1",
      tags: "setup",
      extraVars: "version=1.2",
      become: true,
      verbosity: 2,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: "playbook",
      state: "running",
      check: true,
    });
    const launch = s.ssh.calls[0]!.stdin;
    const run = Buffer.from(extractRun(launch), "base64").toString();
    expect(run).toContain("ansible-playbook");
    expect(run).toContain("-b -vv");
    expect(run).toContain("-l 'web,!db1'");
    expect(run).toContain("-t 'setup'");
    expect(run).toContain("-C 'site.yml'");
    expect(run).not.toContain("inventory.json");
    expect(run).not.toContain("ANSIBLE_HOST_KEY_CHECKING");
  });

  it("builds the inventory from Termix hosts", async () => {
    s = await startServer();
    await s.request("POST", "/1/runs", {
      kind: "adhoc",
      hostIds: [2, 3],
      pattern: "all",
      module: "command",
      args: "uptime; rm -rf /",
    });
    const launch = s.ssh.calls[0]!.stdin;
    const run = Buffer.from(extractRun(launch), "base64").toString();
    expect(run).toContain("ansible 'all' -i \"$D/secret/inventory.json\"");
    expect(run).toContain("-m 'command' -a 'uptime; rm -rf /'");
    expect(run).toContain("ANSIBLE_HOST_KEY_CHECKING=False");
    expect(launch).toContain("secret/keys/h2");
    expect(launch).not.toContain("pw3");
    expect(launch).not.toContain("KEYDATA");
  });

  it("needs edit access to every target", async () => {
    s = await startServer({ level: "edit" });
    const res = await s.request("POST", "/1/runs", {
      kind: "adhoc",
      hostIds: [99],
    });
    expect(res.status).toBe(404);
    expect(s.ssh.calls).toHaveLength(0);
  });

  it("refuses odd values", async () => {
    s = await startServer();
    for (const body of [
      { kind: "playbook", playbook: "../x.yml" },
      { kind: "playbook", playbook: "a.yml", limit: "a; reboot" },
      { kind: "playbook", playbook: "a.yml", tags: "-x" },
      { kind: "adhoc", module: "shell;x" },
      { kind: "adhoc", pattern: "-m" },
      { kind: "nope" },
    ]) {
      const res = await s.request("POST", "/1/runs", body);
      expect(res.status).toBe(400);
    }
    expect(s.ssh.calls).toHaveLength(0);
  });

  it("lists runs newest first", async () => {
    s = await startServer({ level: "connect" });
    const older = {
      ...META,
      id: "1600000000000-aaaaaa",
      startedAt: 1600000000000,
    };
    s.ssh.replies.push({
      match: "meta.json",
      stdout: `@@run\n${JSON.stringify(older)}\n@@result\n0 1600000100\n@@run\n${JSON.stringify(META)}\n@@alive\n`,
    });
    const res = await s.request("GET", "/1/runs");
    expect(res.body.runs.map((r: { id: string }) => r.id)).toEqual([
      META.id,
      older.id,
    ]);
    expect(res.body.runs[0].state).toBe("running");
    expect(res.body.runs[1].state).toBe("ok");
  });

  it("returns a run with its recap", async () => {
    s = await startServer();
    s.ssh.replies.push({
      match: "tail -c",
      stdout: `@@run\n${JSON.stringify(META)}\n@@result\n0 1700000100\n@@size\n80\n@@log\nPLAY RECAP ***\nweb1 : ok=1 changed=0 unreachable=0 failed=0\n`,
    });
    const res = await s.request("GET", `/1/runs/${META.id}`);
    expect(res.body.state).toBe("ok");
    expect(res.body.recap[0]).toMatchObject({ host: "web1", ok: 1 });
    expect(res.body.log).toContain("PLAY RECAP");
  });

  it("answers 404 for a missing run and refuses bad ids", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "tail -c", stdout: "@@missing\n" });
    expect((await s.request("GET", `/1/runs/${META.id}`)).status).toBe(404);
    expect((await s.request("GET", "/1/runs/..%2Fetc")).status).toBe(400);
  });

  it("stops a run", async () => {
    s = await startServer();
    await s.request("POST", `/1/runs/${META.id}/cancel`);
    expect(s.ssh.calls[0]!.stdin).toContain("kill -TERM");
  });
});

describe("targets", () => {
  it("lists hosts with folders and tags", async () => {
    s = await startServer();
    const res = await s.request("GET", "/1/targets");
    expect(res.body.targets).toHaveLength(3);
    expect(
      res.body.targets.find((t: { id: number }) => t.id === 2),
    ).toMatchObject({
      folder: "Servers/Web",
      tags: ["prod", "web"],
    });
  });
});

/** The run.sh body, which launchScript passes as base64. */
function extractRun(launch: string): string {
  const line = launch
    .split("\n")
    .find((l) => l.includes('base64 -d > "$D/run.sh"'))!;
  return /printf %s '([^']+)'/.exec(line)![1]!;
}
