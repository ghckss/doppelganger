import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendSlackStyleMemory,
  buildSlackStyleGuide,
  parseSlackStyleMemory,
  stringifySlackStyleMemory
} from '../src/slack-style-memory.js';

test('slack style memory preserves multiline replies', () => {
  const state = appendSlackStyleMemory('', {
    taskId: 'task-1',
    prompt: '<@U123> 공유 부탁드립니다.',
    generatedReply: '확인했습니다. 공유드리겠습니다.',
    finalReply: '확인했습니다.\n범위 정리해서 공유드리겠습니다.'
  });
  const raw = stringifySlackStyleMemory(state);
  const parsed = parseSlackStyleMemory(raw);

  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].finalReply, '확인했습니다.\n범위 정리해서 공유드리겠습니다.');
  assert.equal(parsed.entries[0].finalReply.includes('\n'), true);
});

test('slack style guide infers multiline directive from user replies', () => {
  let raw = '';

  const replies = [
    '확인했습니다.\n범위 정리해서 공유드리겠습니다.',
    '확인했습니다.\n정리 후 업데이트 드리겠습니다.',
    '확인했습니다.\n우선순위 먼저 공유드리겠습니다.',
    '확인했습니다. 전달드리겠습니다.'
  ];
  for (const [index, reply] of replies.entries()) {
    const state = appendSlackStyleMemory(raw, {
      taskId: `task-${index + 1}`,
      prompt: '공유 요청',
      generatedReply: '확인했습니다. 공유드리겠습니다.',
      finalReply: reply
    });
    raw = stringifySlackStyleMemory(state);
  }

  const styleGuide = buildSlackStyleGuide(raw, { maxExamples: 2 });
  assert.ok(styleGuide);
  assert.equal(styleGuide.multilineRate >= 50, true);
  assert.match(styleGuide.directives.join(' '), /줄바꿈/);
  assert.equal(styleGuide.examples.some((example) => String(example.finalReply || '').includes('\n')), true);
});
