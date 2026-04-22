// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { logCommandEnd, logCommandStart } from '../command-log.js';

const STREAM_CAPTURE_LIMIT = 256 * 1024;
const FILE_CAPTURE_LIMIT = 512 * 1024;

function normalizeAgentProvider(value, fallback = 'codex') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'claude') {
    return normalized;
  }
  return fallback;
}

function createTempDir(provider = 'codex') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `doppelganger-gen-${provider}-`));
}

function truncateOutput(value, maxLength = 16000) {
  const text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function createCapture(limit = STREAM_CAPTURE_LIMIT) {
  return {
    text: '',
    truncated: false,
    limit
  };
}

function appendCapture(capture, chunk) {
  if (capture.truncated) {
    return;
  }

  const value = chunk.toString('utf8');
  if (!value) {
    return;
  }

  const remaining = capture.limit - capture.text.length;
  if (remaining <= 0) {
    capture.truncated = true;
    return;
  }

  if (value.length > remaining) {
    capture.text += value.slice(0, remaining);
    capture.truncated = true;
    return;
  }

  capture.text += value;
}

function finalizeCapture(capture) {
  if (!capture.truncated) {
    return capture.text;
  }
  return `${capture.text}\n...[output truncated]`;
}

function readFileLimited(filePath, maxBytes = FILE_CAPTURE_LIMIT) {
  if (!fs.existsSync(filePath)) {
    return '';
  }

  const stat = fs.statSync(filePath);
  const fileSize = Number(stat?.size || 0);
  const readSize = Math.max(0, Math.min(maxBytes, fileSize || maxBytes));
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(readSize);
    const bytesRead = fs.readSync(fd, buffer, 0, readSize, 0);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (fileSize > maxBytes) {
      text += '\n...[file truncated]';
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

export class CliGenerationClient {
  constructor(config) {
    this.config = config;
  }

  isConfigured() {
    return Boolean(this.config.codex?.command || this.config.claude?.command);
  }

  resolveAgentProvider(agentProvider) {
    return normalizeAgentProvider(agentProvider, this.config.generation?.defaultAgentProvider || 'codex');
  }

  resolveCommand(agentProvider) {
    const provider = this.resolveAgentProvider(agentProvider);
    if (provider === 'claude') {
      return this.config.claude?.command || 'claude';
    }
    return this.config.codex?.command || 'codex';
  }

  async createTextResponse({ instructions, input, agentProvider, scope = 'default' }) {
    const resolvedAgentProvider = this.resolveAgentProvider(agentProvider);
    const command = this.resolveCommand(resolvedAgentProvider);
    const cwd = path.resolve(this.config.cwd || process.cwd());
    const outputDir = createTempDir(resolvedAgentProvider);
    const outputFile = path.join(outputDir, 'last-message.txt');
    const scopedTimeout = this.config.generation?.scopeTimeoutSeconds?.[scope];
    const globalTimeout = Number(this.config.generation?.timeoutSeconds ?? 90);
    const timeoutSeconds = Number.isFinite(Number(scopedTimeout))
      ? Number(scopedTimeout)
      : globalTimeout;
    const timeoutMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0;
    const prompt = [
      'You are a response generator for an automation service.',
      'Follow the provided instructions exactly and return only the requested output.',
      '',
      `Generation scope: ${scope}`,
      '',
      'Instructions:',
      String(instructions || ''),
      '',
      'Input:',
      String(input || '')
    ].join('\n');

    const args = [
      'exec',
      '-C',
      cwd,
      '--skip-git-repo-check',
      '--color',
      'never',
      '-o',
      outputFile,
      '--sandbox',
      'read-only',
      '-'
    ];

    const startedAt = Date.now();
    logCommandStart({
      source: `generation:${scope}`,
      command,
      args,
      cwd
    });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const stdoutCapture = createCapture();
      const stderrCapture = createCapture();
      let timedOut = false;

      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, timeoutMs);
      }

      child.stdout.on('data', (chunk) => {
        appendCapture(stdoutCapture, chunk);
      });
      child.stderr.on('data', (chunk) => {
        appendCapture(stderrCapture, chunk);
      });
      child.stdin.on('error', (error) => {
        if (error.code === 'EPIPE') {
          return;
        }
        if (timer) {
          clearTimeout(timer);
        }
        reject(error);
      });
      child.on('error', (error) => {
        if (timer) {
          clearTimeout(timer);
        }
        logCommandEnd({
          source: `generation:${scope}`,
          command,
          args,
          cwd,
          code: error?.code || 'spawn_error',
          durationMs: Date.now() - startedAt,
          error: error?.message || 'spawn error'
        });
        reject(error);
      });
      child.on('close', (code) => {
        if (timer) {
          clearTimeout(timer);
        }
        logCommandEnd({
          source: `generation:${scope}`,
          command,
          args,
          cwd,
          code: code ?? 1,
          durationMs: Date.now() - startedAt,
          error: timedOut ? `timeout>${timeoutSeconds}s` : ''
        });
        resolve({
          code: code ?? 1,
          stdout: truncateOutput(finalizeCapture(stdoutCapture)),
          stderr: truncateOutput(finalizeCapture(stderrCapture)),
          timedOut
        });
      });

      child.stdin.end(prompt);
    });

    if (result.timedOut) {
      throw new Error(`${resolvedAgentProvider} 생성 CLI 호출이 ${timeoutSeconds}초 제한 시간을 초과했습니다`);
    }

    if (result.code !== 0) {
      const providerLabel = resolvedAgentProvider === 'claude' ? 'Claude' : 'Codex';
      const lastMessage = readFileLimited(outputFile).trim();
      const detail = [result.stderr, lastMessage].filter(Boolean).join('\n');
      throw new Error(`${providerLabel} 생성 CLI가 상태 코드 ${result.code}로 종료되었습니다${detail ? `: ${truncateOutput(detail, 600)}` : ''}`);
    }

    const text = readFileLimited(outputFile).trim();
    if (!text) {
      throw new Error(`${resolvedAgentProvider} 생성 CLI 응답이 비어 있습니다`);
    }

    return {
      text,
      provider: resolvedAgentProvider,
      durationMs: Date.now() - startedAt,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
}
