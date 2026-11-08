import { afterEach, describe, expect, it } from "vitest";
import { startServer, type TestServer } from "./helpers";

let s: TestServer | null = null;

afterEach(async () => {
  await s?.close();
  s = null;
});

const now = Date.now();
const meta = (id: string, title: string) => ({
  id,
  kind: "playbook",
  title,
  command: `ansible-playbook ${title}`,
  startedAt: now - 60_000,
  startedBy: "u1",
  check: false,
  hosts: [],
});

function runsOutput() {
  const fail = meta("1-aaaaaa", "deploy.yml");
  const ok = meta("2-bbbbbb", "site.yml");
  const ended = Math.floor(now / 1000);
  return `@@run\n${JSON.stringify(fail)}\n@@result\n2 ${ended}\n@@run\n${JSON.stringify(ok)}\n@@result\n0 ${ended}\n`;
}

async function setup(settings: Record<string, unknown> = {}) {
  s = await startServer({ settings });
  s.mock.ctx.currentActor = () => "u1";
  Object.assign(s.mock.ctx.hosts, { list: async () => [{ id: 1 }] });
  s.ssh.replies.push({ match: "meta.json", stdout: runsOutput() });
  return s;
}

describe("summary", () => {
  it("counts failed runs in the last week", async () => {
    const t = await setup();
    const res = await t.request("GET", "/summary");
    expect(res.body[0]).toMatchObject({ hostId: 1, failed: 1, running: 0 });
    expect(res.body[0].last).toBeTruthy();
  });

  it("alerts for a run that fails after the first look, once", async () => {
    const t = await setup();
    await t.request("GET", "/summary?refresh=1");
    expect(t.mock.notifications).toHaveLength(0);
    await t.mock.ctx.kv.set("alerted:u1:1", []);
    await t.request("GET", "/summary?refresh=1");
    expect(t.mock.notifications).toHaveLength(1);
    expect(t.mock.notifications[0]!.notification.category).toBe(
      "ansible.failed",
    );
    await t.request("GET", "/summary?refresh=1");
    expect(t.mock.notifications).toHaveLength(1);
  });

  it("stays quiet when alerts are off", async () => {
    const t = await setup({ alertRuns: false });
    await t.mock.ctx.kv.set("alerted:u1:1", []);
    await t.request("GET", "/summary?refresh=1");
    expect(t.mock.notifications).toHaveLength(0);
  });
});
