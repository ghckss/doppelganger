import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { logCommandEnd, logCommandStart } from '../core/command-log.ts';

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

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// API 일시 오류(인증 블립/과부하/레이트리밋/5xx/타임아웃)는 재시도로 해소되는 경우가 많다.
function isTransientCliFailure(result: RunExecResult): boolean {
  if (!result || result.code === 0) {
    return false;
  }
  if (result.timedOut) {
    return true;
  }
  const blob = `${result.stdout || ''}\n${result.stderr || ''}`.toLowerCase();
  return /(\b(401|408|409|425|429|500|502|503|504|529)\b)|invalid authentication credentials|failed to authenticate|overloaded|rate.?limit|too many requests|temporarily unavailable|service unavailable|timed? ?out|econnreset|etimedout|enotfound|fetch failed|socket hang up|api error/.test(blob);
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
      // 설치된 'runner' 스킬이 자동 트리거되어 단일 단계 호출을 다단계 워크플로로 하이재킹하면
      // (StructuredOutput 툴로 JSON을 보내고 마지막 메시지는 산문) --output-schema가 무시되고 파싱이 깨진다.
      // 각 호출은 워크플로의 한 단계이므로 codex skills.config로 runner 스킬을 비활성화한다.
      args.push('-c', 'skills.config=[{name="runner", enabled=false}]');

      if (sandboxMode === 'workspace-write') {
        args.push('--full-auto');
      } else {
        args.push('--sandbox', sandboxMode);
      }
      args.push('-');
    } else {
      args.push('-p');
      // 주의: Claude의 --json-schema(StructuredOutput 채널)는 긴 도구 사용 세션 후
      // error_max_structured_output_retries로 자주 실패한다. 대신 프롬프트에서 "JSON만 출력"을 지시하고
      // 일반 텍스트 응답에서 JSON을 파싱한다(extractJsonObject). 스킬 자동 실행은 비활성화한다.
      args.push('--disable-slash-commands');
      // Claude CLI has no codex-style sandbox flags. Use non-interactive permission mode
      // so automation can proceed without blocking prompts.
      args.push('--permission-mode', 'bypassPermissions');
      args.push('-');
    }

    // API 일시 오류(인증 블립/과부하/레이트리밋/5xx/타임아웃)는 백오프 후 재시도한다.
    const maxAttempts = 3;
    let result: RunExecResult | null = null;
    let startedAt = Date.now();
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      startedAt = Date.now();
      logCommandStart({
        source: `agent:${this.provider}`,
        command: this.command,
        args,
        cwd
      });

      let attemptResult: RunExecResult;
      try {
        attemptResult = await new Promise<RunExecResult>((resolve, reject) => {
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
      } catch (spawnError) {
        // spawn 단계 실패(EPIPE 제외)도 일시적일 수 있으므로 재시도.
        if (attempt < maxAttempts) {
          await sleep(attempt * 2000);
          continue;
        }
        throw spawnError;
      }

      result = attemptResult;
      if (!isTransientCliFailure(attemptResult) || attempt >= maxAttempts) {
        break;
      }
      logCommandEnd({
        source: `agent:${this.provider}`,
        command: this.command,
        args,
        cwd,
        code: attemptResult.code,
        durationMs: Date.now() - startedAt,
        error: `transient failure, retrying (attempt ${attempt}/${maxAttempts})`
      });
      await sleep(attempt * 2000);
    }

    if (!result) {
      throw new Error('CLI 실행 결과를 얻지 못했습니다');
    }

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

    // 모든 provider 동일: 스키마가 있으면 마지막 메시지/텍스트에서 JSON을 추출·검증한다.
    // (Claude도 --json-schema 대신 프롬프트의 "JSON only" 지시 + 텍스트 파싱을 사용한다.)
    let parsed: Record<string, unknown> | null = null;
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
