// @ts-nocheck
import path from 'node:path';
import { spawn } from 'node:child_process';
import { logCommandEnd, logCommandStart } from '../command-log.js';

const STREAM_CAPTURE_LIMIT = 256 * 1024;

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

function resolveTimeoutSeconds(config, scope = 'github_review') {
  const scopedTimeout = config.generation?.scopeTimeoutSeconds?.[scope];
  const globalTimeout = Number(config.generation?.timeoutSeconds ?? 90);
  const timeoutSeconds = Number.isFinite(Number(scopedTimeout))
    ? Number(scopedTimeout)
    : globalTimeout;
  return timeoutSeconds > 0 ? timeoutSeconds : 0;
}

export class HovisReviewClient {
  constructor(config) {
    this.config = config;
  }

  isConfigured() {
    return Boolean(String(this.config.externalAgent?.command || this.config.hovis?.command || '').trim());
  }

  async createPullRequestReview({ pullRequestUrl, scope = 'github_review' }) {
    const command = String(this.config.externalAgent?.command || this.config.hovis?.command || '').trim();
    const normalizedPullRequestUrl = String(pullRequestUrl || '').trim();
    if (!command) {
      throw new Error('EXTERNAL_AGENT_COMMAND가 설정되지 않았습니다');
    }
    if (!normalizedPullRequestUrl) {
      throw new Error('PR URL이 없어 외부 에이전트 리뷰를 실행할 수 없습니다');
    }

    const cwd = path.resolve(this.config.cwd || process.cwd());
    const timeoutSeconds = resolveTimeoutSeconds(this.config, scope);
    const timeoutMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0;
    const startedAt = Date.now();
    const args = ['pr'];
    logCommandStart({
      source: `external-agent:${scope}`,
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
        logCommandEnd({
          source: `external-agent:${scope}`,
          command,
          args,
          cwd,
          code: error?.code || 'stdin_error',
          durationMs: Date.now() - startedAt,
          error: error?.message || 'stdin error'
        });
        reject(error);
      });
      child.on('error', (error) => {
        if (timer) {
          clearTimeout(timer);
        }
        logCommandEnd({
          source: `external-agent:${scope}`,
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
          source: `external-agent:${scope}`,
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

      child.stdin.end(`${normalizedPullRequestUrl}\n`);
    });

    if (result.timedOut) {
      throw new Error(`외부 에이전트 리뷰 CLI 호출이 ${timeoutSeconds}초 제한 시간을 초과했습니다`);
    }

    if (result.code !== 0) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join('\n');
      throw new Error(`외부 에이전트 리뷰 CLI가 상태 코드 ${result.code}로 종료되었습니다${detail ? `: ${truncateOutput(detail, 600)}` : ''}`);
    }

    const text = String(result.stdout || result.stderr || '').trim();
    if (!text) {
      throw new Error('외부 에이전트 리뷰 CLI 응답이 비어 있습니다');
    }

    return {
      text,
      durationMs: Date.now() - startedAt,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
}
