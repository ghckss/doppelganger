import assert from 'node:assert/strict';
import test from 'node:test';
import { GenerationClient } from '../src/generation-client.ts';

function createConfig(overrides = {}) {
  return {
    generation: {
      provider: 'cli',
      defaultAgentProvider: 'codex',
      scopeProviders: {},
      scopeAgentProviders: {}
    },
    agent: {
      defaultProvider: 'codex'
    },
    ...overrides
  };
}

test('GenerationClient routes github_review scope to external provider', async () => {
  const config = createConfig({
    generation: {
      provider: 'cli',
      defaultAgentProvider: 'codex',
      scopeProviders: {
        github_review: 'external'
      },
      scopeAgentProviders: {}
    }
  });

  let called = false;
  const client = new GenerationClient({
    config,
    openaiClient: {
      isConfigured: () => false
    },
    cliClient: {
      isConfigured: () => true
    },
    externalAgentClient: {
      isConfigured: () => true,
      createPullRequestReview: async ({ pullRequestUrl, scope }) => {
        called = true;
        assert.equal(scope, 'github_review');
        assert.equal(pullRequestUrl, 'https://github.com/acme/demo/pull/99');
        return {
          text: 'external agent review body'
        };
      }
    }
  });

  const result = await client.createTextResponse({
    scope: 'github_review',
    pullRequestUrl: 'https://github.com/acme/demo/pull/99',
    instructions: '',
    input: ''
  });

  assert.equal(called, true);
  assert.equal(result.provider, 'external_agent');
  assert.equal(result.text, 'external agent review body');
});

test('GenerationClient rejects external provider on non-github scopes', async () => {
  const config = createConfig({
    generation: {
      provider: 'external',
      defaultAgentProvider: 'codex',
      scopeProviders: {},
      scopeAgentProviders: {}
    }
  });
  const client = new GenerationClient({
    config,
    openaiClient: {
      isConfigured: () => false
    },
    cliClient: {
      isConfigured: () => false
    },
    externalAgentClient: {
      isConfigured: () => true,
      createPullRequestReview: async () => {
        return {
          text: 'should not be called'
        };
      }
    }
  });

  await assert.rejects(
    () => client.createTextResponse({
      scope: 'slack',
      instructions: '',
      input: ''
    }),
    /github_review 스코프/
  );
});
