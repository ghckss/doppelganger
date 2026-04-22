import http from 'node:http';
import { parseRequestBody, readStringField, sendJson } from '../http-utils.ts';
import { type LlmServiceApi } from '../http-types.ts';

export async function handleMeetingRoutes({
  request,
  response,
  pathname,
  summarizer
}: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  pathname: string;
  summarizer: LlmServiceApi;
}): Promise<boolean> {
  if (request.method !== 'POST' || pathname !== '/api/meetings/summarize') {
    return false;
  }

  const body = await parseRequestBody(request);
  const transcript = readStringField(body, 'transcript');
  if (!transcript) {
    sendJson(response, 400, {
      ok: false,
      error: '회의 전사 내용이 필요합니다'
    });
    return true;
  }

  if (!summarizer?.generateMeetingSummary) {
    throw new Error('회의 정리 서비스를 사용할 수 없습니다');
  }

  const result = await summarizer.generateMeetingSummary({
    transcript,
    startedAt: readStringField(body, 'startedAt'),
    endedAt: readStringField(body, 'endedAt'),
    language: readStringField(body, 'language') || 'ko-KR'
  });

  sendJson(response, 200, {
    ok: true,
    summary: result.summary,
    polishedTranscript: result.polishedTranscript || '',
    document: result.document,
    provider: result.provider,
    agentProvider: result.agentProvider || ''
  });
  return true;
}
