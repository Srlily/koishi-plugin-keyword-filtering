import { Context, Dict, Schema, Session, h } from 'koishi';
import type { OneBot } from 'koishi-plugin-adapter-onebot';

export const name = 'keyword-filtering';

interface ViolationRecord {
  count: number;
  timer: NodeJS.Timeout;
}

export interface Content {
  bot: OneBot.GroupMemberInfo;
  user: OneBot.GroupMemberInfo;
  message: string;
}

export interface Config {
  blockingRules: GroupRule[];
}

interface GroupRule {
  groupId: string;
  enable: boolean;
  muteConfig: {
    enable: boolean;
    threshold: number;
    duration: number;
  };
  blockingWords: Dict<BlockingWords, string>;
  customMessage: string;
  alertContent: string;
  correctPrefix: string;
}

interface BlockingWords {
  enable: boolean;
  triggerMute: boolean;
  recall: boolean;
  replace: boolean;
  replaceWord: string;
}

export const Config: Schema<Config> = Schema.object({
  blockingRules: Schema.array(
    Schema.object({
      groupId: Schema.string()
        .required()
        .description('群号（5-12位数字）')
        .pattern(/^\d{5,12}$/),
      enable: Schema.boolean().description('启用群组规则').default(true),
      muteConfig: Schema.object({
        enable: Schema.boolean().description('启用累计禁言').default(false),
        threshold: Schema.natural().min(1).description('触发次数阈值').default(3),
        duration: Schema.natural().role('s').description('禁言时长（秒）').default(600),
      }).description('禁言设置'),
      blockingWords: Schema.dict(
        Schema.object({
          enable: Schema.boolean().description('启用规则').default(true),
          triggerMute: Schema.boolean().description('触发禁言').default(false),
          recall: Schema.boolean().description('撤回消息').default(false),
          replace: Schema.boolean().description('替换内容').default(false),
          replaceWord: Schema.string().description('替换文本').default(''),
        }).description('单个违禁词规则'),
      ).role('table').description('违禁词列表'),
      customMessage: Schema.string()
        .description('自定义提示消息（留空不显示）')
        .default('请遵守群规！'),
      alertContent: Schema.string()
        .description('违规提示内容（支持CQ码）')
        .default('检测到违规内容！'),
      correctPrefix: Schema.string()
        .description('修正内容前缀（留空不显示）')
        .default('修正内容：')
    }).description('群组配置')
  )
  .description('群组规则列表')
  .role('table', { 
    entryName: '群号 {groupId}',
    tableType: 'grid',
    fields: [
      'groupId', 
      'enable', 
      { path: 'muteConfig', name: '禁言设置' },
      { path: 'blockingWords', name: '违禁词' },
      { path: 'customMessage', name: '提示消息' },
      { path: 'alertContent', name: '违规提示' },
      { path: 'correctPrefix', name: '修正前缀' }
    ]
  })
});

export async function handleMsg(ctx: Context, meta: Session): Promise<Content> {
  const [bot, user] = await Promise.all([
    meta.onebot.getGroupMemberInfo(meta.guildId, meta.selfId),
    meta.onebot.getGroupMemberInfo(meta.guildId, meta.userId),
  ]);

  const message = meta.elements
    .map((e) => {
      switch (e.type) {
        case 'at': return `[CQ:at,qq=${e.attrs.id}]`;
        case 'image': return `[CQ:image,file=${e.attrs.file}]`;
        case 'face': return `[CQ:face,id=${e.attrs.id}]`;
        case 'mface': return `[CQ:mface,id=${e.attrs.emojiId}]`;
        default: return e.attrs?.content || '';
      }
    })
    .join('');

  return { bot, user, message };
}

export function apply(ctx: Context) {
  const violationRecords = new Map<string, ViolationRecord>();
  const configDict = new Map<string, GroupRule>(
    ctx.config.blockingRules.map(rule => [rule.groupId, rule])
  );

  ctx.middleware(async (meta, next) => {
    if (!meta.onebot || meta.subtype !== 'group') return next();

    const groupId = meta.guildId;
    const groupConfig = configDict.get(groupId);
    if (!groupConfig?.enable) return next();

    try {
      const { bot, user, message } = await handleMsg(ctx, meta);
      if (!['admin', 'owner'].includes(bot.role)) return next();

      let modifiedMessage = message;
      let needRecall = false;
      let muteCount = 0;
      let hasTriggerMuteRule = false;
      let hasValidReplace = false;

      // 处理违禁词检测
      for (const [pattern, rule] of Object.entries(groupConfig.blockingWords)) {
        if (!rule.enable) continue;

        const regex = new RegExp(`(?<!\\$CQ:\\w+.*?\\$CQ)\\s*(${pattern})`, 'gis');
        if (regex.test(modifiedMessage)) {
          if (rule.enable) {
            modifiedMessage = modifiedMessage.replace(regex, rule.replace ? rule.replaceWord : '');
            hasValidReplace = true;
          }
          needRecall ||= rule.recall;
          if (rule.triggerMute) {
            hasTriggerMuteRule = true;
            muteCount = 1;
          }
        }
      }

      let shouldMute = false;
      if (groupConfig.muteConfig.enable && hasTriggerMuteRule) {
        const recordKey = `${groupId}:${meta.userId}`;
        let record = violationRecords.get(recordKey);

        if (!record) {
          record = {
            count: 0,
            timer: setTimeout(() => {
              ctx.logger.debug(`[自动重置] 用户 ${meta.userId} 违规计数已清除`);
              violationRecords.delete(recordKey);
            }, 24 * 3600 * 1000),
          };
          violationRecords.set(recordKey, record);
        }

        record.count += muteCount;
        shouldMute = record.count >= groupConfig.muteConfig.threshold;

        if (shouldMute) {
          try {
            // 触发禁言前先撤回消息
            if (needRecall) {
              await meta.onebot.deleteMsg(meta.messageId)
                .catch(e => ctx.logger.warn(`[${groupId}] 消息撤回失败: ${e.message}`));
            }

            await meta.onebot.setGroupBan(groupId, meta.userId, groupConfig.muteConfig.duration);

            const totalSeconds = groupConfig.muteConfig.duration;
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.ceil((totalSeconds % 3600) / 60);
            let durationText = '';
            if (hours > 0) durationText += `${hours}小时`;
            if (minutes > 0) durationText += `${minutes}分钟`;

            const contentPart = hasValidReplace && modifiedMessage !== message 
              ? `${groupConfig.correctPrefix}${modifiedMessage}\n` 
              : '';

            await meta.onebot.sendGroupMsg(groupId, 
              `[CQ:at,qq=${meta.userId}] ${groupConfig.alertContent}\n` +
              contentPart +
              `因累计违规 ${record.count}/${groupConfig.muteConfig.threshold} 次，已被禁言 ${durationText}`
            );

            clearTimeout(record.timer);
            violationRecords.delete(recordKey);
          } catch (error) {
            ctx.logger.error(`[${groupId}] 禁言处理失败: ${error.message}`);
          }
        }
      }

      if ((modifiedMessage !== message || needRecall) && !shouldMute) {
        try {
          // 非禁言情况处理撤回
          if (needRecall) {
            await meta.onebot.deleteMsg(meta.messageId)
              .catch(e => ctx.logger.warn(`[${groupId}] 消息撤回失败: ${e.message}`));
          }

          let finalMessage = '';
          if (meta.quote?.id) finalMessage += `[CQ:reply,id=${meta.quote.id}]`;
          finalMessage += `[CQ:at,qq=${meta.userId}] ${groupConfig.alertContent}\n`;

          if (hasValidReplace && modifiedMessage !== message) {
            const cqPattern = /$CQ:[^$]*]/g;
            const parts = modifiedMessage.split(cqPattern);
            let escapedText = '';
            for (let i = 0; i < parts.length; i++) {
              escapedText += (i % 2 === 0) 
                ? parts[i].replace(/&/g, '&amp;') 
                : parts[i];
            }
            finalMessage += `${groupConfig.correctPrefix}${escapedText.slice(0, 2000)}\n`;
          }

          if (hasTriggerMuteRule && groupConfig.muteConfig.enable) {
            const record = violationRecords.get(`${groupId}:${meta.userId}`);
            finalMessage += `累计违规 ${record?.count || 0}/${groupConfig.muteConfig.threshold} 次后禁言！`;
          } else {
            if (groupConfig.customMessage) {
              finalMessage += groupConfig.customMessage;
            }
          }

          await meta.onebot.sendGroupMsg(groupId, finalMessage.slice(0, 4500));
        } catch (error) {
          ctx.logger.error(`[${groupId}] 消息处理失败: ${error.message}`);
        }
      }
    } catch (error) {
      ctx.logger.error(`[${groupId}] 处理异常: ${error.message}`);
    }

    return next();
  }, true);
}