import { planningCommands } from './planning.ts';
import { intentCommands } from './intent.ts';
import { accessCommands } from './access.ts';
import { createDeliveryCommands } from './delivery.ts';
import type { BlobStore } from '../../infrastructure/src/blobs.ts';
import type { CommandRegistry } from './ports.ts';
import { dashboardPersonalCommands } from './dashboard-personal.ts';
import { dashboardTimeCommands } from './dashboard-time.ts';
import { dashboardSprintsCommands } from './dashboard-sprints.ts';
import { dashboardPortfolioCommands } from './dashboard-portfolio.ts';
import { dashboardPlanningCommands } from './dashboard-planning.ts';
import { projectExtrasCommands } from './project-extras.ts';
import { projectDirectoryCommands } from './project-directory.ts';
import { memberDirectoryCommands } from './member-directory.ts';
import { createInvitationCommands, type InvitationProjectValidator } from './invitations.ts';
import type { InvitationMailConfig } from '../../infrastructure/src/invitation-mail.ts';
import { teamWorkloadCommands } from './team-workload.ts';
import { workspaceIdentityCommands } from './workspace-identity.ts';
import { taskCommentsCommands } from './task-comments.ts';
import { notificationCommands } from './notifications.ts';
import { createWebhookCommands } from './webhooks.ts';
import type { WebhookConfig } from '../../infrastructure/src/webhook-config.ts';

export function createRegistry(blobs: BlobStore, invitationMail?: InvitationMailConfig, validateInvitationProjects?: InvitationProjectValidator, webhooks?: WebhookConfig): CommandRegistry {
  const registries = [planningCommands, intentCommands, accessCommands, createDeliveryCommands(blobs), dashboardPersonalCommands, dashboardTimeCommands, dashboardSprintsCommands, dashboardPortfolioCommands, dashboardPlanningCommands, projectExtrasCommands(blobs), projectDirectoryCommands, memberDirectoryCommands, createInvitationCommands(invitationMail, validateInvitationProjects), teamWorkloadCommands, workspaceIdentityCommands, taskCommentsCommands, notificationCommands, createWebhookCommands(webhooks, validateInvitationProjects)];
  const result: CommandRegistry = {};
  for (const entries of registries) {
    for (const [name, definition] of Object.entries(entries)) {
      if (result[name]) throw new Error(`Duplicate command registration: ${name}`);
      result[name] = definition;
    }
  }
  return result;
}
