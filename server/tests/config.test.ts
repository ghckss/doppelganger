import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.ts';

test('loadConfig reads .env file and normalizes lists', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-'));
  fs.writeFileSync(path.join(cwd, '.env'), [
    'APP_PORT=9999',
    'APP_CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173',
    'GITHUB_REPOSITORIES=alpha,beta',
    'WORKSPACE_ALLOWLIST=repo-a,repo-b',
    'SLACK_IGNORE_CHANNELS=C123,#ops-alerts',
    'AGENT_PROVIDER=claude',
    'CLAUDE_COMMAND=claude-custom',
    'EXTERNAL_AGENT_COMMAND=external-agent-custom',
    'GENERATION_PROVIDER=cli',
    'GENERATION_TIMEOUT_SECONDS=0',
    'SLACK_GENERATION_AGENT_PROVIDER=codex',
    'GITHUB_REVIEW_PROVIDER=external',
    'CODE_PLANNING_PROVIDER=fallback',
    'GITHUB_REVIEW_TIMEOUT_SECONDS=180',
    'SLACK_GENERATION_TIMEOUT_SECONDS=0',
    'SLACK_CODE_REVIEW_TIMEOUT_SECONDS=240'
  ].join('\n'));

  const config = loadConfig({ cwd, env: {} });

  assert.equal(config.app.port, 9999);
  assert.deepEqual(config.app.corsOrigins, ['http://localhost:5173', 'http://127.0.0.1:5173']);
  assert.deepEqual(config.github.repositories, ['alpha', 'beta']);
  assert.equal(config.workspace.projectsRoot, path.join(os.homedir(), 'workspace'));
  assert.deepEqual(config.workspace.allowlist, [
    path.join(os.homedir(), 'workspace', 'repo-a'),
    path.join(os.homedir(), 'workspace', 'repo-b')
  ]);
  assert.deepEqual(config.slack.ignoreChannels, ['C123', '#ops-alerts']);
  assert.equal(config.agent.defaultProvider, 'claude');
  assert.equal(config.claude.command, 'claude-custom');
  assert.equal(config.externalAgent.command, 'external-agent-custom');
  assert.equal(config.hovis.command, 'external-agent-custom');
  assert.equal(config.generation.provider, 'cli');
  assert.equal(config.generation.defaultAgentProvider, 'claude');
  assert.equal(config.generation.timeoutSeconds, 0);
  assert.equal(config.generation.scopeAgentProviders.slack, 'codex');
  assert.equal(config.generation.scopeProviders.github_review, 'external');
  assert.equal(config.generation.scopeProviders.code_planning, 'fallback');
  assert.equal(config.generation.scopeTimeoutSeconds.github_review, 180);
  assert.equal(config.generation.scopeTimeoutSeconds.slack, 0);
  assert.equal(config.slack.codeReviewTimeoutSeconds, 240);
});

test('loadConfig resolves WORKSPACE_ALLOWLIST absolute/relative/tilde entries', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-allowlist-'));
  fs.writeFileSync(path.join(cwd, '.env'), [
    'WORKSPACE_ALLOWLIST=repo-a,./repo-b,~/repo-c,/tmp/repo-d'
  ].join('\n'));

  const config = loadConfig({ cwd, env: {} });
  assert.deepEqual(config.workspace.allowlist, [
    path.join(os.homedir(), 'workspace', 'repo-a'),
    path.join(cwd, 'repo-b'),
    path.join(os.homedir(), 'repo-c'),
    path.resolve('/tmp/repo-d')
  ]);
});

test('loadConfig loads Slack code keyword rules from JSON file', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-keywords-'));
  fs.mkdirSync(path.join(cwd, 'config'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'config', 'keywords.json'), JSON.stringify([
    {
      id: 'auth',
      keywords: ['로그인', 'auth'],
      repositories: ['fromm-web'],
      searchTerms: ['auth', 'token'],
      pathHints: ['auth'],
      repositoryFolders: {
        'fromm-web': 'apps/channel'
      },
      weight: 2
    }
  ], null, 2));
  fs.writeFileSync(path.join(cwd, '.env'), [
    'SLACK_CODE_KEYWORDS_PATH=config/keywords.json'
  ].join('\n'));

  const config = loadConfig({ cwd, env: {} });

  assert.equal(config.slack.codeKeywordRules.length, 1);
  assert.equal(config.slack.codeKeywordRules[0].id, 'auth');
  assert.deepEqual(config.slack.codeKeywordRules[0].keywords, ['로그인', 'auth']);
  assert.deepEqual(config.slack.codeKeywordRules[0].repositories, ['fromm-web']);
  assert.deepEqual(config.slack.codeKeywordRules[0].repositoryFolders, {
    'fromm-web': 'apps/channel'
  });
  assert.equal(config.slack.codeKeywordRules[0].weight, 2);
  assert.equal(config.slack.codeKeywordsPath, path.join(cwd, 'config', 'keywords.json'));
});
