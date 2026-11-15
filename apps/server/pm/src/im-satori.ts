import type { Pool } from 'pg';
import { DomainError, type Actor, type Command, type CommandReceipt, type Entity } from '../../../../packages/domain/src/core.ts';
import { satoriEventSchema, type ImBot, type ImConnectivity, type SatoriEvent } from '../../../../packages/contracts/src/im-gateway.ts';
import type { ImGatewayConfig } from '../../../../packages/infrastructure/src/im-gateway-config.ts';
import { createSatoriClient, sendSatoriMessage, type SatoriConnectionStatus, type SatoriBotStatus } from '../../../../packages/infrastructure/src/satori-client.ts';
import {
  consumeImLinkCode, deterministicImId, enqueueImJob, resolveImBinding, revokeImBinding,
  setImDefaultProject, setImNotification, truncateImText, type ImIdentity, type ImBindingRow, type ResolvedImBinding,
} from '../../../../packages/application/src/im-gateway.ts';

export type ImCommandPorts = {
  execute(actor: Actor, workspaceId: string, command: Command): Promise<CommandReceipt>;
  list(actor: Actor, workspaceId: string, kind: 'project' | 'work_item', limit: number, projectId?: string): Promise<Entity[]>;
  read(actor: Actor, workspaceId: string, id: string): Promise<Entity>;
  findWatch(actor: Actor, workspaceId: string, taskId: string, projectId: string): Promise<{ id: string; version: number } | null>;
};

export type ImRuntime = {
  start(): void;
  stop(): void;
  status(): ImConnectivity;
  handleEvent(raw: unknown): Promise<void>;
};

type ParsedCommand = { name: string; rest: string };

function commandText(event: SatoriEvent): string {
  const content = event.message?.content?.trim();
  if (content) return content;
  return (event.message?.elements ?? []).map(element => {
    if (element.type !== 'text') return '';
    const value = element.attrs?.content;
    return typeof value === 'string' ? value : '';
  }).join('').trim();
}

function parseCommand(text: string): ParsedCommand | null {
  const cleaned = text.replace(/^(?:<at\b[^>]*\/>|<at\b[^>]*>[\s\S]*?<\/at>)\s*/, '').replace(/^@\S+\s+/, '').trim();
  const match = /^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/.exec(cleaned);
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), rest: (match[2] ?? '').trim() };
}

function valueText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function taskTitle(entity: Entity): string {
  return valueText(entity.data.title) || entity.id;
}

function taskStatus(entity: Entity): string {
  return valueText(entity.data.status) || 'unknown';
}

function projectName(entity: Entity): string {
  return valueText(entity.data.name) || valueText(entity.data.title) || entity.id;
}

function safeError(code: string | undefined): string {
  switch (code) {
    case 'im_link_invalid': return '链接码无效或已过期，请在 Dovspace 设置页重新生成。';
    case 'im_link_rate_limited': return '尝试次数过多，请稍后再试。';
    case 'im_already_linked': return '该平台账号已绑定其他工作区，请先解除原绑定。';
    case 'im_membership_inactive': return '当前成员资格已失效，请联系工作区管理员。';
    case 'im_not_linked': return '尚未绑定。请先在 Dovspace 设置 → 即时通讯生成链接码，然后发送 /link <链接码>。';
    case 'im_binding_not_found': return '绑定不存在或已撤销。';
    case 'permission_denied': return '当前成员没有执行此操作的权限。';
    case 'not_found_or_forbidden': return '对象不存在或无权访问。';
    case 'version_conflict': return '对象已变化，请刷新后再试。';
    case 'invalid_transition': return '当前工作流不允许此状态转换。';
    case 'project_required': return '请先使用 /use <项目ID> 选择项目。';
    case 'validation_failed': return '请求参数不完整或格式不正确。';
    case 'command_outcome_unknown': return '结果未知。请先到 Dovspace 核对原操作，不要直接重发。';
    default: return `未完成${code ? `（${code}）` : ''}。`;
  }
}

function taskLine(entity: Entity): string {
  return `${entity.id} ${taskTitle(entity)} [${taskStatus(entity)}]`;
}

function parseTaskArgs(rest: string, fallbackProject: string | null): { projectId: string | null; title: string } {
  const first = rest.split(/\s+/, 1)[0] ?? '';
  if (/^[A-Z][A-Z0-9]*-\d+$/.test(first)) return { projectId: first, title: rest.slice(first.length).trim() };
  return { projectId: fallbackProject, title: rest.trim() };
}

export function createImSatoriRuntime(options: {
  config: ImGatewayConfig;
  database: () => Pool;
  ports: ImCommandPorts;
  publicOrigin: string;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): ImRuntime {
  const pool = () => options.database();
  const log = options.log ?? (() => undefined);
  const rates = new Map<string, number[]>();
  const busy = new Set<string>();
  function publicBots(current: SatoriConnectionStatus): ImBot[] {
    return current.bots.map((bot: SatoriBotStatus): ImBot => {
      const username = bot.platform === 'telegram' ? options.config.botUsername : null;
      return {
        platform: bot.platform, selfId: bot.selfId, name: bot.name, status: bot.status,
        username,
        url: username ? `https://t.me/${username}` : null,
      };
    });
  }

  async function sendDirect(event: SatoriEvent, text: string): Promise<void> {
    if (!event.channel || !event.user) return;
    try {
      await sendSatoriMessage({
        apiUrl: options.config.apiUrl,
        token: options.config.token,
        platform: event.platform,
        selfId: event.self_id,
        channelId: event.channel.id,
        content: truncateImText(text, 3_500),
        timeoutMs: options.config.timeoutMs,
      });
    } catch { log('im_direct_reply_failed'); }
  }

  async function reply(binding: ImBindingRow, identity: ImIdentity, sourceId: string, text: string, scope: { projectId?: string | null; taskId?: string | null } = {}): Promise<void> {
    await enqueueImJob(pool(), binding, 'reply', `${identity.platform}:${identity.botSelfId}:${sourceId}`, truncateImText(text, 3_500), scope);
  }

  function commandId(identity: ImIdentity, workspaceId: string, actorId: string, sourceId: string, commandType: string): string {
    return deterministicImId([identity.platform, identity.botSelfId, identity.platformUserId, workspaceId, actorId, sourceId, commandType].join('\0'));
  }

  async function readTask(resolved: ResolvedImBinding, taskId: string): Promise<Entity> {
    if (!/^[A-Z][A-Z0-9]*-\d+$/.test(taskId)) throw new DomainError('validation_failed', 'A task ID is required', 400);
    const task = await options.ports.read(resolved.actor, resolved.binding.workspace_id, taskId);
    if (task.kind !== 'work_item' || !task.projectId) throw new DomainError('not_found_or_forbidden', 'Task is not accessible', 404);
    return task;
  }

  async function replyReceipt(resolved: ResolvedImBinding, identity: ImIdentity, sourceId: string, commandType: string, receipt: CommandReceipt, fallbackTask?: Entity, projectId?: string | null): Promise<void> {
    if (receipt.status === 'committed') {
      if (commandType === 'CreateTaskComment') {
        await reply(resolved.binding, identity, sourceId, '评论已创建。', { projectId: projectId ?? fallbackTask?.projectId ?? null, taskId: fallbackTask?.id ?? null });
        return;
      }
      if (commandType === 'WatchTask' || commandType === 'UnwatchTask') {
        await reply(resolved.binding, identity, sourceId, commandType === 'WatchTask' ? '已关注该任务。' : '已取消关注。', { projectId: projectId ?? fallbackTask?.projectId ?? null, taskId: fallbackTask?.id ?? null });
        return;
      }
      const result = receipt.result as { id?: unknown; data?: unknown } | undefined;
      const resultId = typeof result?.id === 'string' ? result.id : undefined;
      const resultData = result?.data as Record<string, unknown> | undefined;
      const title = valueText(resultData?.title) || (fallbackTask ? taskTitle(fallbackTask) : resultId ?? '');
      const status = valueText(resultData?.status) || (fallbackTask ? taskStatus(fallbackTask) : '');
      const text = resultId
        ? `已完成${title ? `：${resultId} ${title}` : `：${resultId}`}${status ? ` [${status}]` : ''}\n${options.publicOrigin.replace(/\/+$/, '')}/pm/${resolved.binding.workspace_id}/entities/${resultId}`
        : '已完成。';
      await reply(resolved.binding, identity, sourceId, text, { projectId: projectId ?? fallbackTask?.projectId ?? (typeof resultData?.projectId === 'string' ? resultData.projectId : null), taskId: resultId ?? null });
    } else {
      await reply(resolved.binding, identity, sourceId, safeError(receipt.error?.code), { projectId: projectId ?? fallbackTask?.projectId ?? null, taskId: fallbackTask?.id ?? null });
    }
  }

  async function executeAndReply(resolved: ResolvedImBinding, identity: ImIdentity, sourceId: string, command: Command, fallbackTask?: Entity): Promise<void> {
    try {
      await replyReceipt(resolved, identity, sourceId, command.commandType, await options.ports.execute(resolved.actor, resolved.binding.workspace_id, command), fallbackTask, command.projectId);
    } catch (error) {
      await reply(resolved.binding, identity, sourceId, safeError(error instanceof DomainError ? error.code : undefined), { projectId: fallbackTask?.projectId ?? null, taskId: fallbackTask?.id ?? null });
    }
  }

  async function handleCommand(event: SatoriEvent, identity: ImIdentity, sourceId: string, command: ParsedCommand): Promise<void> {
    if (command.name === 'help') {
      await sendDirect(event, '可用命令：/link <码>、/unlink、/notify on|off、/projects、/use <项目ID>、/task [项目ID] <标题>、/tasks、/mine、/show <任务ID>、/comment <任务ID> <文本>、/watch <任务ID>、/unwatch <任务ID>、/start <任务ID>、/done <任务ID>、/cancel <任务ID> <原因>。');
      return;
    }
    if (command.name === 'link') {
      if (!command.rest) { await sendDirect(event, '用法：/link <Dovspace 设置页生成的链接码>'); return; }
      try {
        const binding = await consumeImLinkCode(pool(), identity, command.rest);
        await reply(binding, identity, sourceId, '绑定成功。请发送 /use <项目ID> 选择默认项目，再使用 /task 创建任务。');
      } catch (error) {
        await sendDirect(event, safeError(error instanceof DomainError ? error.code : undefined));
      }
      return;
    }
    let resolved: ResolvedImBinding;
    try {
      resolved = await resolveImBinding(pool(), identity);
    } catch (error) {
      await sendDirect(event, safeError(error instanceof DomainError ? error.code : undefined));
      return;
    }
    const { binding, actor } = resolved;
    const workspaceId = binding.workspace_id;
    if (command.name === 'unlink') {
      await revokeImBinding(pool(), actor, workspaceId, binding.id);
      await sendDirect(event, '已解除绑定。后续消息不会再执行业务命令。');
      return;
    }
    if (command.name === 'notify') {
      if (command.rest !== 'on' && command.rest !== 'off') { await reply(binding, identity, sourceId, '用法：/notify on 或 /notify off'); return; }
      const updated = await setImNotification(pool(), actor, workspaceId, binding.id, command.rest === 'on');
      await reply(binding, identity, sourceId, updated.notifyEnabled ? '已开启通知。新通知会发送到当前私聊。' : '已关闭通知。');
      return;
    }
    if (command.name === 'projects') {
      const projects = await options.ports.list(actor, workspaceId, 'project', 20);
      const active = projects.filter(project => project.data.archived !== true);
      await reply(binding, identity, sourceId, active.length
        ? active.map(project => `${project.id} ${projectName(project)}`).join('\n')
        : '当前没有可读项目。');
      return;
    }
    if (command.name === 'use') {
      const projectId = command.rest.split(/\s+/, 1)[0] ?? '';
      if (!/^[A-Z][A-Z0-9]*-\d+$/.test(projectId)) { await reply(binding, identity, sourceId, '用法：/use <项目ID>'); return; }
      const project = await options.ports.read(actor, workspaceId, projectId);
      if (project.kind !== 'project' || project.data.archived === true) throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
      await setImDefaultProject(pool(), binding, project.id);
      await reply(binding, identity, sourceId, `默认项目已设为 ${project.id} ${projectName(project)}。`);
      return;
    }
    if (command.name === 'task') {
      const { projectId, title } = parseTaskArgs(command.rest, binding.default_project_id);
      if (!projectId) { await reply(binding, identity, sourceId, '请先 /use <项目ID> 选择默认项目，或在命令中写明项目 ID。'); return; }
      if (!title) { await reply(binding, identity, sourceId, '用法：/task [项目ID] <标题>'); return; }
      const project = await options.ports.read(actor, workspaceId, projectId);
      if (project.kind !== 'project' || project.data.archived === true) throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
      const commandIdValue = commandId(identity, workspaceId, actor.id, sourceId, 'CreateWorkItem');
      await executeAndReply(resolved, identity, sourceId, {
        commandId: commandIdValue, commandType: 'CreateWorkItem', projectId,
        payload: { title: truncateImText(title, 300), description: '', acceptanceCriteria: [], kind: 'task' },
      });
      return;
    }
    if (command.name === 'tasks' || command.name === 'mine') {
      const projectId = binding.default_project_id;
      if (!projectId) { await reply(binding, identity, sourceId, '请先 /use <项目ID> 选择项目。'); return; }
      const tasks = await options.ports.list(actor, workspaceId, 'work_item', 100, projectId);
      const visible = tasks.filter(task => task.projectId === projectId && task.data.archived !== true && !['done', 'cancelled', 'canceled'].includes(taskStatus(task)))
        .filter(task => command.name !== 'mine' || task.data.assigneeId === actor.id).slice(0, 10);
      await reply(binding, identity, sourceId, visible.length ? visible.map(taskLine).join('\n') : '没有符合条件的未完成任务。', { projectId });
      return;
    }
    if (command.name === 'show' || command.name === 'start' || command.name === 'done' || command.name === 'cancel' || command.name === 'watch' || command.name === 'unwatch' || command.name === 'comment') {
      const first = command.rest.split(/\s+/, 1)[0] ?? '';
      if (!/^[A-Z][A-Z0-9]*-\d+$/.test(first)) { await reply(binding, identity, sourceId, `用法：/${command.name} <任务ID>${command.name === 'comment' ? ' <文本>' : command.name === 'cancel' ? ' <原因>' : ''}`); return; }
      const task = await readTask(resolved, first);
      const projectId = task.projectId!;
      if (command.name === 'show') { await reply(binding, identity, sourceId, `${taskLine(task)}\n${options.publicOrigin.replace(/\/+$/, '')}/pm/${workspaceId}/entities/${task.id}`, { projectId }); return; }
      if (command.name === 'comment') {
        const content = command.rest.slice(first.length).trim();
        if (!content) { await reply(binding, identity, sourceId, '用法：/comment <任务ID> <文本>'); return; }
        await executeAndReply(resolved, identity, sourceId, {
          commandId: commandId(identity, workspaceId, actor.id, sourceId, 'CreateTaskComment'), commandType: 'CreateTaskComment', targetId: task.id, projectId,
          payload: { content: truncateImText(content, 16_000) },
        }, task);
        return;
      }
      if (command.name === 'watch') {
        await executeAndReply(resolved, identity, sourceId, {
          commandId: commandId(identity, workspaceId, actor.id, sourceId, 'WatchTask'), commandType: 'WatchTask', projectId,
          payload: { taskId: task.id },
        }, task);
        return;
      }
      if (command.name === 'unwatch') {
        const watch = await options.ports.findWatch(actor, workspaceId, task.id, projectId);
        if (!watch) { await reply(binding, identity, sourceId, '当前没有关注该任务。'); return; }
        await executeAndReply(resolved, identity, sourceId, {
          commandId: commandId(identity, workspaceId, actor.id, sourceId, 'UnwatchTask'), commandType: 'UnwatchTask', targetId: watch.id, projectId,
          expectedVersions: { [watch.id]: watch.version }, payload: {},
        }, task);
        return;
      }
      if (command.name === 'cancel') {
        const reason = command.rest.slice(first.length).trim();
        if (!reason) { await reply(binding, identity, sourceId, '用法：/cancel <任务ID> <原因>'); return; }
        await executeAndReply(resolved, identity, sourceId, {
          commandId: commandId(identity, workspaceId, actor.id, sourceId, 'CancelWorkItem'), commandType: 'CancelWorkItem', targetId: task.id, projectId,
          payload: { reason: truncateImText(reason, 16_000) },
        }, task);
        return;
      }
      const commandType = command.name === 'start' ? 'StartWorkItem' : 'CompleteWorkItem';
      await executeAndReply(resolved, identity, sourceId, {
        commandId: commandId(identity, workspaceId, actor.id, sourceId, commandType), commandType, targetId: task.id, projectId, payload: {},
      }, task);
      return;
    }
    await reply(binding, identity, sourceId, '未知命令。发送 /help 查看可用命令。');
  }

  async function routeEvent(raw: unknown): Promise<void> {
    const parsed = satoriEventSchema.safeParse(raw);
    if (!parsed.success) return;
    const event = parsed.data;
    if (!options.config.platforms.includes(event.platform) || event.user?.is_bot === true) return;
    const connection = client.status();
    if (connection.state === 'ready' && connection.bots.length > 0
      && !connection.bots.some(bot => bot.platform === event.platform && bot.selfId === event.self_id)) return;
    const text = commandText(event);
    if (!text.startsWith('/')) return;
    const command = parseCommand(text);
    if (!command) return;
    if (!event.user || !event.channel) return;
    const rateKey = `${event.platform}:${event.self_id}:${event.user.id}`;
    const now = Date.now();
    const recent = (rates.get(rateKey) ?? []).filter(value => now - value < 60_000);
    if (recent.length >= 20) { await sendDirect(event, '命令过于频繁，请稍后再试。'); return; }
    recent.push(now);
    rates.set(rateKey, recent);
    if (rates.size > 1_000) for (const [key, values] of rates) if (!values.some(value => now - value < 60_000)) rates.delete(key);
    if (event.guild || event.channel.type !== undefined && event.channel.type !== 1) {
      await sendDirect(event, '当前仅支持私聊。请在与机器人的私聊中使用命令。');
      return;
    }
    if (!event.message?.id) {
      await sendDirect(event, '无法确认消息唯一性，本次未执行。');
      return;
    }
    const identity: ImIdentity = {
      gatewayId: options.config.gatewayId,
      platform: event.platform,
      botSelfId: event.self_id,
      platformUserId: event.user.id,
      platformUserName: event.user.name ?? event.user.nick ?? null,
      replyChannelId: event.channel.id,
    };
    const sourceId = `${event.channel.id}:${event.message.id}`;
    if (busy.has(rateKey)) { await sendDirect(event, '上一条命令仍在处理，请稍后再试。'); return; }
    busy.add(rateKey);
    try {
      try { await handleCommand(event, identity, sourceId, command); }
      catch (error) {
        log('im_command_failed', { code: error instanceof DomainError ? error.code : 'internal_error' });
        await sendDirect(event, safeError(error instanceof DomainError ? error.code : 'internal_error'));
      }
    } finally { busy.delete(rateKey); }
  }

  const client = createSatoriClient({
    url: options.config.wsUrl,
    token: options.config.token,
    onEvent: routeEvent,
    onError: code => log('im_satori_error', { code }),
  });

  return {
    start() { client.start(); },
    stop() { client.stop(); },
    status(): ImConnectivity {
      const current = client.status();
      return {
        satori: {
          state: current.state,
          readyAt: current.readyAt,
          lastEventAt: current.lastEventAt,
          lastErrorCode: current.lastErrorCode,
        },
        bots: publicBots(current),
      };
    },
    async handleEvent(raw: unknown) {
      try { await routeEvent(raw); }
      catch (error) { log('im_event_failed', { code: error instanceof DomainError ? error.code : 'internal_error' }); }
    },
  };
}
