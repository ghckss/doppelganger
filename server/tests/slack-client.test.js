import assert from 'node:assert/strict';
import test from 'node:test';
import { SlackClient } from '../src/connectors/slack-client.js';

test('SlackClient searches mentions without brittle date filter and applies ts cutoff locally', async () => {
  const requests = [];
  const fetchStub = async (url, options) => {
    const body = options.body.toString();
    requests.push(body);
    if (url.endsWith('/users.info')) {
      const params = new URLSearchParams(body);
      const user = params.get('user');
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({
          ok: true,
          user: {
            id: user,
            profile: {
              display_name: user === 'U123' ? 'hochan' : 'teammate'
            }
          }
        })
      };
    }

    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({
        ok: true,
        messages: {
          paging: {
            pages: 1
          },
          matches: [
            {
              ts: '200',
              text: '<@U123> new mention',
              channel: { id: 'C1', name: 'eng' }
            },
            {
              ts: '100',
              text: '<@U123> old mention',
              channel: { id: 'C1', name: 'eng' }
            }
          ]
        }
      })
    };
  };

  const client = new SlackClient({
    slack: {
      readToken: 'xoxp-test',
      writeToken: 'xoxp-test',
      userId: 'U123',
      searchPageSize: 100,
      searchMaxPages: 3
    }
  }, fetchStub);

  const matches = await client.searchMentionsSince({ cutoffUnixSeconds: 150 });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].ts, '200');
  assert.equal(matches[0].text, '@hochan new mention');
  assert.match(requests[0], /query=%3CU123%3E|query=%3C%40U123%3E/);
  assert.doesNotMatch(requests[0], /after%3A/);
});

test('SlackClient derives thread root ts from permalink and resolves names', async () => {
  const client = new SlackClient({
    slack: {
      readToken: 'xoxp-test',
      writeToken: 'xoxp-test',
      userId: 'U123',
      searchPageSize: 100,
      searchMaxPages: 3
    }
  }, async (url, options) => {
    if (url.endsWith('/users.info')) {
      const params = new URLSearchParams(options.body.toString());
      const user = params.get('user');
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({
          ok: true,
          user: {
            id: user,
            profile: {
              display_name: user === 'U123' ? 'hochan' : 'teammate'
            }
          }
        })
      };
    }

    throw new Error('not used');
  });

  const normalized = await client.normalizeMatch({
    ts: '1775619316.055019',
    text: '<@U123> 이건어떻게되냐',
    user: 'U999',
    permalink: 'https://example.slack.com/archives/C1/p1775619316055019?thread_ts=1775618741.058149',
    channel: {
      id: 'C1',
      name: 'eng'
    }
  });

  assert.equal(normalized.ts, '1775619316.055019');
  assert.equal(normalized.threadTs, '1775618741.058149');
  assert.equal(normalized.text, '@hochan 이건어떻게되냐');
  assert.equal(normalized.userName, 'teammate');
});

test('SlackClient logs why users.info lookup failed and falls back to the user id', async () => {
  const warnings = [];
  const client = new SlackClient({
    slack: {
      readToken: 'xoxp-test',
      writeToken: 'xoxp-test',
      userId: 'U123',
      searchPageSize: 100,
      searchMaxPages: 3
    }
  }, async (url) => {
    if (url.endsWith('/users.info')) {
      throw new Error('socket hang up');
    }

    throw new Error('not used');
  }, {
    warn: (...args) => warnings.push(args)
  });

  const name = await client.resolveUserDisplayName('U999', 'U999');

  assert.equal(name, 'U999');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], '[Slack users.info lookup failed]');
  assert.equal(warnings[0][1].userId, 'U999');
  assert.equal(warnings[0][1].reason, 'api_failed');
  assert.match(warnings[0][1].error, /users\.info|socket hang up/);
});

test('SlackClient postReply preserves line breaks in Slack message text', async () => {
  const requests = [];
  const client = new SlackClient({
    slack: {
      readToken: 'xoxp-test',
      writeToken: 'xoxp-test',
      userId: 'U123',
      searchPageSize: 100,
      searchMaxPages: 3
    }
  }, async (url, options) => {
    const body = options.body.toString();
    requests.push({ url, body });
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({
        ok: true,
        ts: '1710000002.000100',
        channel: 'C123',
        message: {
          text: 'ok'
        }
      })
    };
  });

  await client.postReply({
    channelId: 'C123',
    threadTs: '1710000000.000100',
    text: '첫 줄\n둘째 줄'
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /chat\.postMessage$/);
  const params = new URLSearchParams(requests[0].body);
  assert.equal(params.get('channel'), 'C123');
  assert.equal(params.get('thread_ts'), '1710000000.000100');
  assert.equal(params.get('text'), '첫 줄\n둘째 줄');
});
