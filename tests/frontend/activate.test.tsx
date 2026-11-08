import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const status = {
  installed: true,
  version: "ansible [core 2.17.4]",
  user: "deploy",
  projectDir: "/home/deploy/ansible",
  projectExists: true,
  sshpass: true,
  canEdit: true,
  readOnly: false,
};

const runs = [
  {
    id: "1700000000000-abcdef",
    kind: "playbook",
    title: "site.yml",
    command: "ansible-playbook site.yml",
    startedAt: 1700000000000,
    startedBy: "u1",
    check: true,
    hosts: [],
    state: "ok",
    exitCode: 0,
    endedAt: 1700000060000,
  },
];

function api(current: unknown) {
  return {
    get: vi.fn(async (url: string) => ({
      data: url.endsWith("/status")
        ? current
        : url.endsWith("/files")
          ? {
              files: [
                {
                  path: "site.yml",
                  size: 120,
                  modified: 1700000000000,
                  playbook: true,
                },
                {
                  path: "vars/main.yml",
                  size: 20,
                  modified: 1700000000000,
                  playbook: false,
                },
              ],
            }
          : url.endsWith("/runs")
            ? { runs }
            : { targets: [] },
    })),
  } as never;
}

const host = { id: 1, name: "control", enableSsh: true };

describe(`${manifest.id} activate`, () => {
  it("registers a dashboard card showing recent runs per host", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      permissions: ["ansible.use"],
      hosts: [{ id: "7", name: "control", ip: "10.0.0.7", port: 22 }],
      api: {
        get: vi.fn(async () => ({
          data: [
            {
              hostId: 7,
              running: 0,
              failed: 2,
              last: {
                id: "1-aaaaaa",
                title: "site.yml",
                state: "failed",
                startedAt: 1700000000000,
              },
              checkedAt: "",
            },
          ],
        })),
      } as never,
    });
    expect(rendered.registered.dashboardCards()).toEqual(["ansible-hosts"]);
    rendered.renderDashboardCard("ansible-hosts");
    expect(await screen.findByText("control")).toBeTruthy();
    expect(screen.getByText("2 failed")).toBeTruthy();
    expect(screen.getByText("site.yml: Failed")).toBeTruthy();
  });

  it("registers the host tab", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual(["ansible"]);
  });

  it("lists playbooks and other files", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(status),
    });
    rendered.renderTab("ansible", { isVisible: true, host });
    expect(await screen.findByText("site.yml")).toBeTruthy();
    expect(screen.getByText("vars/main.yml")).toBeTruthy();
    expect(screen.getAllByText(locales.files.playbook).length).toBe(1);
  });

  it("shows recent runs", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(status),
    });
    rendered.renderTab("ansible", { isVisible: true, host });
    fireEvent.click(await screen.findByText(locales.tab.viewRuns));
    expect(await screen.findByText(locales.runs.state.ok)).toBeTruthy();
  });

  it("explains when ansible is missing", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ ...status, installed: false }),
    });
    rendered.renderTab("ansible", { isVisible: true, host });
    expect(await screen.findByText(locales.tab.notInstalledTitle)).toBeTruthy();
  });

  it("hides ad-hoc and facts from view only callers", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ ...status, canEdit: false }),
    });
    rendered.renderTab("ansible", { isVisible: true, host });
    await screen.findByText("site.yml");
    expect(screen.queryByText(locales.tab.viewAdhoc)).toBeNull();
  });

  it("shows an error when the host cannot be read", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: {
        get: vi.fn(async () => {
          throw new Error("offline");
        }),
      } as never,
    });
    rendered.renderTab("ansible", { isVisible: true, host });
    expect(await screen.findByText(locales.tab.error)).toBeTruthy();
  });
});
