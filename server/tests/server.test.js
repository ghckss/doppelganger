import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpServer } from '../src/server.js';

function createTaskServiceStub() {
  return {
    config: {
      app: {
        baseUrl: 'http://127.0.0.1:4318',
        corsOrigins: []
      }
    }
  };
}

async function withTestServer({ llmService }, callback) {
  const server = createHttpServer({
    taskService: createTaskServiceStub(),
    llmService
  });
  await new Promise((resolve, reject) => {
    const handleListening = () => {
      server.off('error', handleError);
      resolve(undefined);
    };
    const handleError = (error) => {
      server.off('listening', handleListening);
      reject(error);
    };
    server.once('listening', handleListening);
    server.once('error', handleError);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('테스트 서버 포트를 확인하지 못했습니다.');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await callback(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(undefined);
      });
    });
  }
}

test('meeting summarize endpoint validates transcript input', async (t) => {
  try {
    await withTestServer({
      llmService: {
        generateMeetingSummary: async () => ({
          summary: '',
          polishedTranscript: '',
          document: ''
        })
      }
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/meetings/summarize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          transcript: '   ',
          startedAt: '',
          endedAt: '',
          language: 'ko-KR'
        })
      });
      const payload = await response.json();
      assert.equal(response.status, 400);
      assert.equal(payload.ok, false);
      assert.match(String(payload.error || ''), /전사 내용/);
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      t.skip('sandbox 환경에서 로컬 포트 바인딩이 제한되어 skip');
      return;
    }
    throw error;
  }
});

test('root path returns api-only 안내', async (t) => {
  try {
    await withTestServer({
      llmService: {
        generateMeetingSummary: async () => ({
          summary: '',
          polishedTranscript: '',
          document: ''
        })
      }
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/`);
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      assert.match(String(payload.message || ''), /API 서버/);
      assert.equal(payload.endpoints?.tasks, '/api/tasks');
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      t.skip('sandbox 환경에서 로컬 포트 바인딩이 제한되어 skip');
      return;
    }
    throw error;
  }
});

test('meeting summarize endpoint returns generated confluence draft', async (t) => {
  try {
    await withTestServer({
      llmService: {
        generateMeetingSummary: async ({ transcript }) => ({
          summary: `요약: ${String(transcript).slice(0, 10)}`,
          polishedTranscript: '회의 원문 테스트를 문맥에 맞게 다듬은 전사문입니다.',
          document: '# 회의 기록\n\n## 회의 개요\n테스트 문서',
          provider: 'cli:codex',
          agentProvider: 'codex'
        })
      }
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/meetings/summarize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          transcript: '회의 원문 테스트',
          startedAt: '2026-04-17T10:00:00.000Z',
          endedAt: '2026-04-17T10:30:00.000Z',
          language: 'ko-KR'
        })
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      assert.match(String(payload.summary || ''), /요약/);
      assert.match(String(payload.polishedTranscript || ''), /다듬은 전사문/);
      assert.match(String(payload.document || ''), /## 회의 개요/);
      assert.equal(payload.provider, 'cli:codex');
      assert.equal(payload.agentProvider, 'codex');
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      t.skip('sandbox 환경에서 로컬 포트 바인딩이 제한되어 skip');
      return;
    }
    throw error;
  }
});
