// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logCommandEnd, logCommandStart } from '../command-log.js';

const execFileAsync = promisify(execFile);

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class WorkspaceRunner {
  constructor(config) {
    this.config = config;
  }

  isConfigured() {
    return this.config.workspace.allowlist.length > 0;
  }

  assertAllowed(workdir) {
    const raw = String(workdir || '').trim();
    if (!raw) {
      throw new Error('작업공간 경로가 필요합니다');
    }

    const absolute = path.resolve(raw);
    const absoluteReal = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
    const allowed = this.config.workspace.allowlist.some((candidate) => {
      const candidateAbsolute = path.resolve(candidate);
      const candidateReal = fs.existsSync(candidateAbsolute)
        ? fs.realpathSync(candidateAbsolute)
        : candidateAbsolute;

      return isPathInside(candidateAbsolute, absolute)
        || isPathInside(candidateAbsolute, absoluteReal)
        || isPathInside(candidateReal, absolute)
        || isPathInside(candidateReal, absoluteReal);
    });
    if (!allowed) {
      throw new Error(`허용되지 않은 작업공간 경로입니다: ${absolute}`);
    }
    if (!fs.existsSync(absolute)) {
      throw new Error(`작업공간 경로가 존재하지 않습니다: ${absolute}`);
    }
    return absolute;
  }

  async run(command, args, { workdir } = {}) {
    const cwd = this.assertAllowed(workdir);
    const commandArgs = Array.isArray(args) ? args : [];
    const startedAt = Date.now();
    logCommandStart({
      source: 'workspace',
      command,
      args: commandArgs,
      cwd
    });

    try {
      const result = await execFileAsync(command, commandArgs, { cwd });
      logCommandEnd({
        source: 'workspace',
        command,
        args: commandArgs,
        cwd,
        code: 0,
        durationMs: Date.now() - startedAt
      });
      return result;
    } catch (error) {
      logCommandEnd({
        source: 'workspace',
        command,
        args: commandArgs,
        cwd,
        code: error?.code,
        durationMs: Date.now() - startedAt,
        error: error?.message || '알 수 없는 오류'
      });
      throw error;
    }
  }
}
