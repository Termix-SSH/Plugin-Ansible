import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Router } from "express";
import {
  createMockCtx,
  type MockPluginContext,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginHostAccess } from "@termix-ssh/plugin-sdk/backend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";

export const manifest = manifestJson as unknown as PluginManifest;

export interface Call {
  hostId: number;
  command: string;
  stdin: string;
}

export interface FakeSsh {
  calls: Call[];
  /** Replies by a piece of the script text. The first match wins. */
  replies: Array<{
    match: string;
    stdout?: string;
    stderr?: string;
    code?: number;
  }>;
}

export interface TestServer {
  mock: MockPluginContext;
  ssh: FakeSsh;
  request: (
    method: string,
    path: string,
    body?: unknown,
    // Route bodies vary per test; asserting on them is the point.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

/** The plugin on a real express app, with ctx.ssh.exec played by a fake. */
export async function startServer(
  options: {
    permissions?: string[];
    level?: PluginHostAccess["permissionLevel"] | "none";
    /** Host 1 settings. The plugin is turned on unless set otherwise. */
    settings?: Record<string, unknown>;
  } = {},
): Promise<TestServer> {
  let router: Router | null = null;
  const mock = createMockCtx({
    sandbox: true,
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    router: () => (router = express.Router()),
    permissions: options.permissions ?? [`${manifest.id}.use`],
  });

  const enableKey = (
    manifest.contributes as { settings: { host: { enableKey: string } } }
  ).settings.host.enableKey;
  const settings = { [enableKey]: true, ...options.settings };
  for (const [key, value] of Object.entries(settings)) {
    mock.settings.set(`host:1:${key}`, value);
  }

  const rank = { connect: 1, view: 2, edit: 3, manage: 4 } as const;
  const level = options.level ?? "manage";
  Object.assign(mock.ctx.hosts, {
    checkAccess: async (
      _id: number,
      need: keyof typeof rank = "connect",
    ): Promise<PluginHostAccess> => ({
      hasAccess: level !== "none" && rank[level] >= rank[need],
      isOwner: true,
      isShared: false,
      permissionLevel: level === "none" ? undefined : level,
    }),
  });

  const summary = (id: number) => ({
    id,
    userId: "u1",
    name: id === 1 ? "control" : `web${id}`,
    ip: `10.0.0.${id}`,
    port: 22,
    username: "root",
    tags: id === 2 ? "prod,web" : "",
    folder: id === 2 ? "Servers/Web" : "",
    authType: "password",
  });
  Object.assign(mock.ctx.hosts, {
    get: async (id: number) => (id === 99 ? null : summary(id)),
    list: async () => [1, 2, 3].map(summary),
  });
  Object.assign(mock.ctx.ssh, {
    resolveHost: async (id: number) =>
      id === 99
        ? null
        : {
            id,
            ip: `10.0.0.${id}`,
            port: 22,
            username: "root",
            password: id === 3 ? "pw3" : undefined,
            key: id === 2 ? "KEYDATA" : undefined,
            sudoPassword: id === 2 ? "sudo2" : undefined,
          },
  });

  const ssh: FakeSsh = { calls: [], replies: [] };
  Object.assign(mock.ctx.ssh, {
    exec: async (
      hostId: number,
      command: string,
      opts?: { stdin?: string },
    ) => {
      const stdin = opts?.stdin ?? "";
      ssh.calls.push({ hostId, command, stdin });
      const reply = ssh.replies.find((r) => stdin.includes(r.match));
      return {
        stdout: reply?.stdout ?? "",
        stderr: reply?.stderr ?? "",
        code: reply?.code ?? 0,
        truncated: false,
        timedOut: false,
      };
    },
  });

  const { activate } = await import("../../src/backend/index.js");
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => router!(req, res, next));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    mock,
    ssh,
    async request(method, path, body) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
