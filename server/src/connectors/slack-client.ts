// @ts-nocheck
import { formatSlackTimestamp, safeArray, toSlackText, truncateText } from '../utils.ts';

function extractThreadTs(match) {
  if (match.thread_ts) {
    return match.thread_ts;
  }

  if (match.permalink) {
    try {
      const url = new URL(match.permalink);
      return url.searchParams.get('thread_ts') || match.ts;
    } catch {
      return match.ts;
    }
  }

  return match.ts;
}

function normalizeReactionName(value) {
  return String(value || '')
    .trim()
    .replace(/^:+|:+$/g, '')
    .replace(/\s+/g, '_')
    .toLowerCase();
}

function summarizeTokenType(token) {
  if (!token) {
    return 'missing';
  }
  if (token.startsWith('xoxp-')) {
    return 'xoxp';
  }
  if (token.startsWith('xoxb-')) {
    return 'xoxb';
  }
  if (token.startsWith('xapp-')) {
    return 'xapp';
  }
  return 'unknown';
}

function formatErrorForLog(error) {
  if (!error) {
    return 'unknown error';
  }

  const message = String(error.message || error);
  const causeMessage = error.cause?.message ? ` | cause: ${error.cause.message}` : '';
  return `${message}${causeMessage}`;
}

export class SlackClient {
  constructor(config, fetchImpl = fetch, logger = console) {
    this.config = config;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.cachedUserId = config.slack.userId || null;
    this.userNameCache = new Map();
    this.userLookupWarningCache = new Set();
  }

  isConfigured() {
    return Boolean(this.config.slack.readToken);
  }

  async callApi(method, { token, params = {}, retryCount = 1 } = {}) {
    const authToken = token || this.config.slack.readToken;
    if (!authToken) {
      throw new Error('SLACK_READ_TOKEN이 설정되지 않았습니다');
    }

    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        body.set(key, String(value));
      }
    }

    let response;
    try {
      response = await this.fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8'
        },
        body
      });
    } catch (error) {
      throw new Error(`Slack API ${method} 네트워크 호출이 실패했습니다: ${formatErrorForLog(error)}`, {
        cause: error
      });
    }

    if (response.status === 429 && retryCount > 0) {
      const retryAfter = Number(response.headers.get('retry-after') || '1');
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      return this.callApi(method, { token: authToken, params, retryCount: retryCount - 1 });
    }

    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `Slack API ${method} 호출이 ${response.status}로 실패했습니다`);
    }

    return payload;
  }

  warnUserLookup(userId, reason, details = {}) {
    const warningKey = `${userId}:${reason}`;
    if (this.userLookupWarningCache.has(warningKey)) {
      return;
    }

    this.userLookupWarningCache.add(warningKey);
    this.logger?.warn?.('[Slack users.info lookup failed]', {
      userId,
      reason,
      tokenType: summarizeTokenType(this.config.slack.readToken),
      ...details
    });
  }

  async resolveUserId() {
    if (this.cachedUserId) {
      return this.cachedUserId;
    }

    const payload = await this.callApi('auth.test');
    this.cachedUserId = payload.user_id;
    return this.cachedUserId;
  }

  async searchMentionsSince({ cutoffUnixSeconds }) {
    const userId = await this.resolveUserId();
    const matches = [];
    let page = 1;

    while (page <= this.config.slack.searchMaxPages) {
      const payload = await this.callApi('search.messages', {
        params: {
          query: `<@${userId}>`,
          sort: 'timestamp',
          sort_dir: 'desc',
          count: this.config.slack.searchPageSize,
          page,
          highlight: false
        }
      });

      const batch = (await Promise.all(
        safeArray(payload.messages?.matches).map((match) => this.normalizeMatch(match))
      )).filter((match) => Number(match.ts) > cutoffUnixSeconds);

      matches.push(...batch);

      const totalPages = Number(payload.messages?.paging?.pages || page);
      const shouldStop = batch.length === 0 || page >= totalPages;
      if (shouldStop) {
        break;
      }

      page += 1;
    }

    return matches;
  }

  async resolveUserDisplayName(userId, fallback = '') {
    if (!userId || !/^U[A-Z0-9]+$/i.test(userId)) {
      return fallback || userId || '알 수 없음';
    }

    if (this.userNameCache.has(userId)) {
      return this.userNameCache.get(userId);
    }

    try {
      const payload = await this.callApi('users.info', {
        params: {
          user: userId
        }
      });
      const profile = payload.user?.profile || {};
      const name = profile.display_name || profile.real_name || payload.user?.real_name || payload.user?.name || fallback || userId;
      if (!profile.display_name && !profile.real_name && !payload.user?.real_name && !payload.user?.name) {
        this.warnUserLookup(userId, 'name_fields_missing', {
          hasProfile: Boolean(payload.user?.profile)
        });
      }
      this.userNameCache.set(userId, name);
      return name;
    } catch (error) {
      this.warnUserLookup(userId, 'api_failed', {
        error: formatErrorForLog(error)
      });
      const name = fallback || userId;
      this.userNameCache.set(userId, name);
      return name;
    }
  }

  async hydrateSlackText(text) {
    const source = String(text || '');
    const ids = [...new Set((source.match(/<@([A-Z0-9]+)>/gi) || []).map((token) => token.slice(2, -1)))];
    if (ids.length === 0) {
      return source;
    }

    const replacements = new Map();
    for (const id of ids) {
      replacements.set(id, await this.resolveUserDisplayName(id, id));
    }

    return source.replace(/<@([A-Z0-9]+)>/gi, (_full, id) => `@${replacements.get(id) || id}`);
  }

  async normalizeMatch(match) {
    const channelId = match.channel?.id || match.channel_id || '';
    const threadTs = extractThreadTs(match);
    const text = await this.hydrateSlackText(match.text || '');
    const user = match.user || match.username || '';
    const userName = user
      ? await this.resolveUserDisplayName(user, match.username || user)
      : (match.username || '알 수 없음');

    return {
      channelId,
      channelName: match.channel?.name || match.channel?.id || 'channel',
      ts: match.ts,
      threadTs,
      permalink: match.permalink || '',
      text,
      user,
      userName,
      createdAt: formatSlackTimestamp(match.ts),
      preview: truncateText(text, 100),
      raw: match
    };
  }

  async getThread({ channelId, threadTs }) {
    const payload = await this.callApi('conversations.replies', {
      params: {
        channel: channelId,
        ts: threadTs,
        limit: 100
      }
    });

    return Promise.all(safeArray(payload.messages).map(async (message, index) => {
      const user = message.user || message.bot_id || '알 수 없음';
      const userName = message.bot_profile?.name || message.username || await this.resolveUserDisplayName(message.user, user);
      return {
        externalId: message.ts,
        title: index === 0 ? '원본 메시지' : `답글 ${index}`,
        content: await this.hydrateSlackText(message.text || ''),
        sortOrder: index,
        createdAt: formatSlackTimestamp(message.ts),
        metadata: {
          user,
          userName,
          threadTs: message.thread_ts || threadTs,
          ts: message.ts,
          replyCount: message.reply_count || 0,
          replyUsers: message.reply_users || []
        }
      };
    }));
  }

  async postReply({ channelId, threadTs, text }) {
    const writeToken = this.config.slack.writeToken || this.config.slack.readToken;
    if (!writeToken) {
      throw new Error('SLACK_WRITE_TOKEN이 설정되지 않았습니다');
    }

    return this.callApi('chat.postMessage', {
      token: writeToken,
      params: {
        channel: channelId,
        thread_ts: threadTs,
        text: toSlackText(text)
      }
    });
  }

  async addReaction({ channelId, ts, name }) {
    const writeToken = this.config.slack.writeToken || this.config.slack.readToken;
    if (!writeToken) {
      throw new Error('SLACK_WRITE_TOKEN이 설정되지 않았습니다');
    }

    const reactionName = normalizeReactionName(name);
    if (!reactionName) {
      return {
        ok: false,
        skipped: true,
        reason: 'reaction_missing'
      };
    }

    try {
      await this.callApi('reactions.add', {
        token: writeToken,
        params: {
          channel: channelId,
          timestamp: ts,
          name: reactionName
        }
      });
      return {
        ok: true,
        name: reactionName
      };
    } catch (error) {
      if (error.message === 'already_reacted') {
        return {
          ok: true,
          name: reactionName,
          alreadyReacted: true
        };
      }
      throw error;
    }
  }
}
