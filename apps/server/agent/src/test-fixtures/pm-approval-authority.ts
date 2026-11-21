import path from "node:path";
import Fastify from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { DomainError } from "../../../../../packages/domain/src/core.ts";
import { Workspace, WorkspaceError } from "../../../../../packages/pm-core/index.ts";
import { createAgentChatTools } from "../../../pm/src/agent-tools/agent-chat-tools.ts";
import { registerAgentToolRoutes } from "../../../pm/src/routes/agent-tool-routes.ts";
import type { CoreWorkspacePool } from "../../../pm/src/routes/core-routes.ts";

export type PmApprovalAuthorityFixture = {
  target: { workspaceId: string; projectId: string };
  task: { id: string; revision: string };
  read(originalRequest: unknown): Promise<{ statusCode: number; body: string }>;
  close(): Promise<void>;
};

/** Real native authority query and source revisions; only the fixture's existing actor/membership SQL is supplied. */
export async function createPmApprovalAuthorityFixture(input: {
  directory: string; workspaceId: string; actorId: string; enabled: () => boolean; archived?: boolean;
}): Promise<PmApprovalAuthorityFixture> {
  const workspace = new Workspace(path.join(input.directory, "approval-native-pm"));
  await workspace.init();
  const project = await workspace.createEntity({ entity: "project", title: "Approval authority project" });
  const created = await workspace.createEntity({ entity: "work_item", project: project.id, title: "Original approval task" });
  const task = input.archived ? await workspace.archive(created.id, created.revision) : created;
  const actor = { id: input.actorId, email: "approval-fixture@example.invalid", name: "Approval fixture" };
  const query = async (text: string) => {
    if (!text.includes("SELECT m.* FROM memberships")) throw new Error("The read-only approval authority fixture must not reserve or mutate an operation.");
    const enabled = input.enabled();
    return { rows: enabled ? [{ user_id: actor.id, workspace_id: input.workspaceId, capabilities: ["domain.read", "planning.lifecycle"],
      project_ids: [project.id], version: 1, revoked_at: null }] : [], rowCount: enabled ? 1 : 0 };
  };
  const database = { query } as unknown as Pool;
  const coreWorkspaces = { get: async () => { await workspace.rescan(); return workspace; }, rootFor: () => workspace.root } as unknown as CoreWorkspacePool;
  const tools = createAgentChatTools({ database: () => database, coreWorkspaces,
    executeCommand: async () => { throw new Error("An approval authority query cannot execute a command."); },
    readCommandReceipt: async () => { throw new Error("An approval authority query cannot recover a command."); },
    readComments: async () => { throw new Error("An approval authority query cannot read unrelated comments."); },
    localProjects: { enabled: false, defaultParent: null } });
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof z.ZodError ? 400 : error instanceof DomainError || error instanceof WorkspaceError ? error.status : 500)
    .send({ error: { code: error instanceof DomainError ? error.code : "invalid_request", message: error instanceof Error ? error.message : "Unknown error" } }));
  registerAgentToolRoutes(app, { database: () => database, actor: async () => actor, coreWorkspaces, tools });
  return {
    target: { workspaceId: input.workspaceId, projectId: project.id },
    task: { id: task.id, revision: task.revision },
    read(originalRequest: unknown) {
      return app.inject({ method: "POST", url: `/api/v1/workspaces/${input.workspaceId}/agent-tools/approval-authority`,
        headers: { "content-type": "application/json" }, payload: JSON.stringify(originalRequest) });
    },
    async close() { await app.close(); await workspace.close(); },
  };
}
