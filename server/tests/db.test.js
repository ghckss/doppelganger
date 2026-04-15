import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRepository } from '../src/db.js';

function createTempRepo() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-db-'));
  return createRepository(path.join(tempDir, 'agent.db'));
}

test('repository upserts tasks and clears nullable fields', () => {
  const repo = createTempRepo();
  const task = repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'C123:1.23',
    title: 'Mention task',
    payload: {
      text: 'hello'
    },
    lastError: 'temporary'
  });

  const updated = repo.updateTask(task.id, {
    status: 'drafted',
    lastError: null,
    summary: 'summary'
  });

  assert.equal(updated.status, 'drafted');
  assert.equal(updated.last_error, null);
  assert.equal(updated.summary, 'summary');
});

test('repository replaces artifacts and stores drafts and executions', () => {
  const repo = createTempRepo();
  const task = repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'C123:4.56',
    title: 'Mention task',
    payload: {}
  });

  repo.replaceArtifacts(task.id, 'slack_message', [
    {
      externalId: '4.56',
      content: 'parent',
      metadata: {
        user: 'U1'
      }
    },
    {
      externalId: '4.57',
      content: 'reply',
      metadata: {
        user: 'U2'
      }
    }
  ]);
  repo.createDraft(task.id, 'draft text', { provider: 'test' });
  repo.logExecution(task.id, 'execute', 'success', { response: { ok: true } });

  assert.equal(repo.listArtifacts(task.id, 'slack_message').length, 2);
  assert.equal(repo.getLatestDraft(task.id).content, 'draft text');
  assert.equal(repo.listExecutions(task.id).length, 1);
});
