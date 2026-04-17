import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createId, nowIso, readJson, writeJson } from './utils.js';

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function mapTask(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    payload: readJson(row.payload_json, {}),
    result: readJson(row.result_json, null)
  };
}

function mapArtifact(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    metadata: readJson(row.metadata_json, {})
  };
}

function mapDraft(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    metadata: readJson(row.metadata_json, {})
  };
}

function mapExecution(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    request: readJson(row.request_json, null),
    response: readJson(row.response_json, null)
  };
}

export function createRepository(databasePath) {
  ensureDirectory(databasePath);

  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      kind TEXT NOT NULL,
      external_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      approval_state TEXT NOT NULL,
      source_url TEXT,
      summary TEXT,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(domain, external_id)
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL,
      external_id TEXT,
      title TEXT,
      content TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, type, external_id),
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      request_json TEXT,
      response_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_domain ON tasks(domain);
    CREATE INDEX IF NOT EXISTS idx_artifacts_task_id ON artifacts(task_id);
    CREATE INDEX IF NOT EXISTS idx_drafts_task_id ON drafts(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_executions_task_id ON executions(task_id, created_at DESC);
  `);

  const statements = {
    getTaskById: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    getTaskByExternalId: db.prepare('SELECT * FROM tasks WHERE domain = ? AND external_id = ?'),
    listTasks: db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC, created_at DESC'),
    listTasksByDomain: db.prepare('SELECT * FROM tasks WHERE domain = ? ORDER BY updated_at DESC, created_at DESC'),
    insertTask: db.prepare(`
      INSERT INTO tasks (
        id, domain, kind, external_id, title, status, approval_state, source_url, summary,
        payload_json, result_json, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateTask: db.prepare(`
      UPDATE tasks
      SET title = ?, status = ?, approval_state = ?, source_url = ?, summary = ?, payload_json = ?,
          result_json = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `),
    deleteArtifactsByType: db.prepare('DELETE FROM artifacts WHERE task_id = ? AND type = ?'),
    insertArtifact: db.prepare(`
      INSERT INTO artifacts (id, task_id, type, external_id, title, content, sort_order, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, type, external_id)
      DO UPDATE SET title = excluded.title, content = excluded.content, sort_order = excluded.sort_order,
        metadata_json = excluded.metadata_json
    `),
    listArtifacts: db.prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY type, sort_order, created_at'),
    listArtifactsByType: db.prepare('SELECT * FROM artifacts WHERE task_id = ? AND type = ? ORDER BY sort_order, created_at'),
    insertDraft: db.prepare('INSERT INTO drafts (id, task_id, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)'),
    latestDraft: db.prepare('SELECT * FROM drafts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'),
    listDrafts: db.prepare('SELECT * FROM drafts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC'),
    insertExecution: db.prepare(`
      INSERT INTO executions (id, task_id, action, status, request_json, response_json, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listExecutions: db.prepare('SELECT * FROM executions WHERE task_id = ? ORDER BY created_at DESC, rowid DESC'),
    getState: db.prepare('SELECT value FROM app_state WHERE key = ?'),
    upsertState: db.prepare(`
      INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `)
  };

  function listTasks({ domain } = {}) {
    const rows = domain ? statements.listTasksByDomain.all(domain) : statements.listTasks.all();
    return rows.map(mapTask);
  }

  function getTask(taskId) {
    return mapTask(statements.getTaskById.get(taskId));
  }

  function getTaskByExternalId(domain, externalId) {
    return mapTask(statements.getTaskByExternalId.get(domain, externalId));
  }

  function upsertTask(taskInput) {
    const existing = taskInput.externalId
      ? mapTask(statements.getTaskByExternalId.get(taskInput.domain, taskInput.externalId))
      : null;
    const timestamp = nowIso();

    if (existing) {
      const nextPayload = taskInput.payload === undefined
        ? existing.payload
        : {
            ...(existing.payload || {}),
            ...(taskInput.payload || {})
          };
      const nextTask = {
        ...existing,
        title: taskInput.title ?? existing.title,
        status: taskInput.status ?? existing.status,
        approval_state: taskInput.approvalState ?? existing.approval_state,
        source_url: taskInput.sourceUrl ?? existing.source_url,
        summary: taskInput.summary ?? existing.summary,
        payload: nextPayload,
        result: taskInput.result ?? existing.result,
        last_error: taskInput.lastError ?? existing.last_error
      };

      statements.updateTask.run(
        nextTask.title,
        nextTask.status,
        nextTask.approval_state,
        nextTask.source_url,
        nextTask.summary,
        writeJson(nextTask.payload),
        writeJson(nextTask.result),
        nextTask.last_error,
        timestamp,
        existing.id
      );

      return getTask(existing.id);
    }

    const taskId = taskInput.id ?? createId('task');
    statements.insertTask.run(
      taskId,
      taskInput.domain,
      taskInput.kind,
      taskInput.externalId ?? null,
      taskInput.title,
      taskInput.status ?? 'new',
      taskInput.approvalState ?? 'pending',
      taskInput.sourceUrl ?? null,
      taskInput.summary ?? null,
      writeJson(taskInput.payload ?? {}),
      writeJson(taskInput.result ?? null),
      taskInput.lastError ?? null,
      timestamp,
      timestamp
    );

    return getTask(taskId);
  }

  function updateTask(taskId, fields) {
    const existing = getTask(taskId);
    if (!existing) {
      return null;
    }

    const nextStatus = fields.status === undefined ? existing.status : fields.status;
    const nextApprovalState = fields.approvalState === undefined ? existing.approval_state : fields.approvalState;
    const nextLastError = fields.lastError === undefined ? existing.last_error : fields.lastError;
    const timestamp = nowIso();
    statements.updateTask.run(
      fields.title === undefined ? existing.title : fields.title,
      nextStatus,
      nextApprovalState,
      fields.sourceUrl === undefined ? existing.source_url : fields.sourceUrl,
      fields.summary === undefined ? existing.summary : fields.summary,
      fields.payload === undefined ? writeJson(existing.payload) : writeJson(fields.payload),
      fields.result === undefined ? writeJson(existing.result) : writeJson(fields.result),
      nextLastError,
      timestamp,
      taskId
    );

    const statusChanged = String(existing.status) !== String(nextStatus);
    const approvalChanged = String(existing.approval_state) !== String(nextApprovalState);
    const lastErrorChanged = String(existing.last_error || '') !== String(nextLastError || '');
    if (statusChanged || approvalChanged || lastErrorChanged) {
      statements.insertExecution.run(
        createId('exec'),
        taskId,
        'task_transition',
        'success',
        writeJson({
          from: {
            status: existing.status,
            approvalState: existing.approval_state,
            lastError: existing.last_error || ''
          },
          to: {
            status: nextStatus,
            approvalState: nextApprovalState,
            lastError: nextLastError || ''
          }
        }),
        writeJson({
          updatedAt: timestamp
        }),
        null,
        timestamp
      );
    }

    return getTask(taskId);
  }

  function replaceArtifacts(taskId, type, artifacts) {
    db.exec('BEGIN');
    try {
      statements.deleteArtifactsByType.run(taskId, type);
      for (const artifact of artifacts) {
        statements.insertArtifact.run(
          artifact.id ?? createId('artifact'),
          taskId,
          type,
          artifact.externalId ?? null,
          artifact.title ?? null,
          artifact.content ?? null,
          artifact.sortOrder ?? 0,
          writeJson(artifact.metadata ?? {}),
          artifact.createdAt ?? nowIso()
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function createArtifact(taskId, type, artifact) {
    statements.insertArtifact.run(
      artifact.id ?? createId('artifact'),
      taskId,
      type,
      artifact.externalId ?? null,
      artifact.title ?? null,
      artifact.content ?? null,
      artifact.sortOrder ?? 0,
      writeJson(artifact.metadata ?? {}),
      artifact.createdAt ?? nowIso()
    );

    const rows = statements.listArtifactsByType.all(taskId, type);
    return mapArtifact(rows.at(-1) || null);
  }

  function listArtifacts(taskId, type) {
    const rows = type ? statements.listArtifactsByType.all(taskId, type) : statements.listArtifacts.all(taskId);
    return rows.map(mapArtifact);
  }

  function createDraft(taskId, content, metadata = {}) {
    const draftId = createId('draft');
    statements.insertDraft.run(draftId, taskId, content, writeJson(metadata), nowIso());
    return mapDraft(statements.latestDraft.get(taskId));
  }

  function getLatestDraft(taskId) {
    return mapDraft(statements.latestDraft.get(taskId));
  }

  function listDrafts(taskId) {
    return statements.listDrafts.all(taskId).map(mapDraft);
  }

  function logExecution(taskId, action, status, details = {}) {
    const executionId = createId('exec');
    statements.insertExecution.run(
      executionId,
      taskId,
      action,
      status,
      writeJson(details.request ?? null),
      writeJson(details.response ?? null),
      details.error ?? null,
      nowIso()
    );
    return executionId;
  }

  function listExecutions(taskId) {
    return statements.listExecutions.all(taskId).map(mapExecution);
  }

  function getState(key, fallback = null) {
    const row = statements.getState.get(key);
    return row ? row.value : fallback;
  }

  function setState(key, value) {
    statements.upsertState.run(key, String(value), nowIso());
  }

  return {
    db,
    listTasks,
    getTask,
    getTaskByExternalId,
    upsertTask,
    updateTask,
    replaceArtifacts,
    createArtifact,
    listArtifacts,
    createDraft,
    getLatestDraft,
    listDrafts,
    logExecution,
    listExecutions,
    getState,
    setState
  };
}
