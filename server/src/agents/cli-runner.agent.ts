import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { logCommandEnd, logCommandStart } from '../command-log.ts';

const STREAM_CAPTURE_LIMIT = 256 * 1024;
const FILE_CAPTURE_LIMIT = 512 * 1024;

interface SpawnCapture {
  text: string;
  truncated: boolean;
  limit: number;
}

interface RunnerConfig {
  codex?: { command?: string };
  claude?: { command?: string };
}

interface RunExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface CliExecutionResult {
  lastMessage: string;
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface CliError extends Error {
  code?: number | string;
  details?: Record<string, unknown>;
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

function appendCapture(capture: SpawnCapture, chunk: Buffer) {
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

function finalizeCapture(capture: SpawnCapture) {
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

function hasRequiredKeys(value, schema) {
  if (!schema || typeof schema !== 'object') {
    return true;
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.length === 0) {
    return true;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function tryParseJsonCandidate(candidate, schema) {
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, parsed: null };
    }
    if (!hasRequiredKeys(parsed, schema)) {
      return { ok: false, parsed };
    }
    return { ok: true, parsed };
  } catch {
    return { ok: false, parsed: null };
  }
}

function extractJsonObject(text, schema = null) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('에이전트 출력이 비어 있습니다');
  }

  const direct = tryParseJsonCandidate(trimmed, schema);
  if (direct.ok) {
    return direct.parsed;
  }

  let fallbackParsed = direct.parsed && typeof direct.parsed === 'object' ? direct.parsed : null;

  const fencedMatches = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/gi) || [];
  for (const fence of fencedMatches) {
    const inner = fence.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    const parsed = tryParseJsonCandidate(inner, schema);
    if (parsed.ok) {
      return parsed.parsed;
    }
    if (!fallbackParsed && parsed.parsed && typeof parsed.parsed === 'object') {
      fallbackParsed = parsed.parsed;
    }
  }

  const source = trimmed;
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '{') {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') {
        depth += 1;
        continue;
      }
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = source.slice(start, index + 1);
          const parsed = tryParseJsonCandidate(candidate, schema);
          if (parsed.ok) {
            return parsed.parsed;
          }
          if (!fallbackParsed && parsed.parsed && typeof parsed.parsed === 'object') {
            fallbackParsed = parsed.parsed;
          }
          break;
        }
      }
    }
  }

  if (fallbackParsed) {
    return fallbackParsed;
  }

  const preview = truncateOutput(trimmed, 300);
  throw new Error(`에이전트 출력에 JSON이 포함되어 있지 않습니다: ${preview}`);
}

function createTempDir(provider = 'agent') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `doppelganger-${provider}-`));
}

class AgentCliRunner {
  config: RunnerConfig;
  workspaceRunner: {
    run: (command: string, args: string[], options: { workdir: string }) => Promise<unknown>;
    assertAllowed: (workdir: string) => string;
  };
  provider: string;
  command: string;

  constructor({ config, workspaceRunner, provider, command }) {
    this.config = config;
    this.workspaceRunner = workspaceRunner;
    this.provider = provider;
    this.command = command || config?.[provider]?.command || provider;
  }

  async assertAvailable(workdir) {
    await this.workspaceRunner.run(this.command, ['--version'], { workdir });
  }

  async runExec({ workdir, prompt, sandboxMode = 'read-only', schema, timeoutSeconds = 0 }) {
    const cwd = this.workspaceRunner.assertAllowed(workdir);
    const useCodexExecMode = this.provider !== 'claude';
    const parsedTimeoutSeconds = Number(timeoutSeconds);
    const effectiveTimeoutSeconds = Number.isFinite(parsedTimeoutSeconds) && parsedTimeoutSeconds > 0
      ? Math.max(1, Math.floor(parsedTimeoutSeconds))
      : 0;
    const timeoutMs = effectiveTimeoutSeconds > 0 ? effectiveTimeoutSeconds * 1000 : 0;
    const tempDir = createTempDir(this.provider);
    const outputFile = useCodexExecMode ? path.join(tempDir, 'last-message.txt') : '';
    const schemaFile = useCodexExecMode && schema ? path.join(tempDir, 'schema.json') : null;
    if (schemaFile) {
      fs.writeFileSync(schemaFile, JSON.stringify(schema, null, 2));
    }

    const args = [];
    if (useCodexExecMode) {
      args.push('exec', '-C', cwd, '--color', 'never', '-o', outputFile);
      if (schemaFile) {
        args.push('--output-schema', schemaFile);
      }

      if (sandboxMode === 'workspace-write') {
        args.push('--full-auto');
      } else {
        args.push('--sandbox', sandboxMode);
      }
      args.push('-');
    } else {
      args.push('-p');
      if (schema) {
        args.push('--json-schema', JSON.stringify(schema));
      }
      // Claude CLI has no codex-style sandbox flags. Use non-interactive permission mode
      // so automation can proceed without blocking prompts.
      args.push('--permission-mode', 'bypassPermissions');
      args.push('-');
    }

    const startedAt = Date.now();
    logCommandStart({
      source: `agent:${this.provider}`,
      command: this.command,
      args,
      cwd
    });

    const result: RunExecResult = await new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const stdoutCapture = createCapture();
      const stderrCapture = createCapture();
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;
      let forceKillTimer: NodeJS.Timeout | null = null;

      const clearTimers = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          forceKillTimer = setTimeout(() => {
            child.kill('SIGKILL');
          }, 5000);
          if (typeof forceKillTimer.unref === 'function') {
            forceKillTimer.unref();
          }
        }, timeoutMs);
      }

      child.stdout.on('data', (chunk) => {
        appendCapture(stdoutCapture, chunk);
      });
      child.stderr.on('data', (chunk) => {
        appendCapture(stderrCapture, chunk);
      });
      child.stdin.on('error', (error: CliError) => {
        if (error.code === 'EPIPE') {
          return;
        }
        clearTimers();
        logCommandEnd({
          source: `agent:${this.provider}`,
          command: this.command,
          args,
          cwd,
          code: error?.code || 'stdin_error',
          durationMs: Date.now() - startedAt,
          error: error?.message || 'stdin error'
        });
        reject(error);
      });
      child.on('error', (error: CliError) => {
        clearTimers();
        logCommandEnd({
          source: `agent:${this.provider}`,
          command: this.command,
          args,
          cwd,
          code: error?.code || 'spawn_error',
          durationMs: Date.now() - startedAt,
          error: error?.message || 'spawn error'
        });
        reject(error);
      });
      child.on('close', (code: number | null) => {
        clearTimers();
        logCommandEnd({
          source: `agent:${this.provider}`,
          command: this.command,
          args,
          cwd,
          code: code ?? 1,
          durationMs: Date.now() - startedAt,
          error: timedOut ? `timeout>${effectiveTimeoutSeconds}s` : ''
        });
        resolve({
          code: code ?? 1,
          stdout: finalizeCapture(stdoutCapture),
          stderr: finalizeCapture(stderrCapture),
          timedOut
        });
      });

      child.stdin.end(prompt);
    });

    const rawStdout = String(result.stdout || '');
    const stdout = truncateOutput(result.stdout);
    const stderr = truncateOutput(result.stderr);
    const lastMessage = useCodexExecMode
      ? readFileLimited(outputFile)
      : rawStdout;
    const normalizedLastMessage = String(lastMessage || '').trim();
    const parseSource = useCodexExecMode
      ? (normalizedLastMessage ? lastMessage : rawStdout)
      : rawStdout;
    const parseSourceOrigin = useCodexExecMode
      ? (normalizedLastMessage ? 'last-message' : 'stdout-fallback')
      : 'stdout';

    if (result.timedOut) {
      const providerLabel = this.provider === 'claude' ? 'Claude' : 'Codex';
      const error = new Error(`${providerLabel} CLI 호출이 ${effectiveTimeoutSeconds}초 제한 시간을 초과했습니다`) as CliError;
      error.details = {
        provider: this.provider,
        command: this.command,
        args,
        cwd,
        stdout,
        stderr,
        lastMessage,
        parseSourceOrigin
      };
      throw error;
    }

    if (result.code !== 0) {
      const providerLabel = this.provider === 'claude' ? 'Claude' : 'Codex';
      const error = new Error(`${providerLabel} CLI가 상태 코드 ${result.code}로 종료되었습니다`) as CliError;
      error.details = {
        provider: this.provider,
        command: this.command,
        args,
        cwd,
        stdout,
        stderr,
        lastMessage,
        parseSourceOrigin
      };
      throw error;
    }

    let parsed = null;
    if (schema) {
      try {
        parsed = extractJsonObject(parseSource, schema);
      } catch (error) {
        const parseError = error as CliError;
        parseError.details = {
          provider: this.provider,
          command: this.command,
          args,
          cwd,
          stdout,
          stderr,
          lastMessage: truncateOutput(lastMessage, 1200),
          parseSourceOrigin,
          parseSource: truncateOutput(parseSource, 1200)
        };
        throw parseError;
      }
    }

    const executionResult: CliExecutionResult = {
      lastMessage,
      parsed,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt
    };
    return executionResult;
  }
}

export class CodexCliRunner extends AgentCliRunner {
  constructor({ config, workspaceRunner }) {
    super({
      config,
      workspaceRunner,
      provider: 'codex',
      command: config.codex?.command || 'codex'
    });
  }
}

export class ClaudeCliRunner extends AgentCliRunner {
  constructor({ config, workspaceRunner }) {
    super({
      config,
      workspaceRunner,
      provider: 'claude',
      command: config.claude?.command || 'claude'
    });
  }
}
