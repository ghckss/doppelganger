# Slack Context-Aware Reply Plan

## Summary

- Goal: replace keyword/template-first Slack replies with a context-aware generation flow.
- New flow: read thread context -> infer response strategy -> generate direct reply for the latest mention.
- Keep the six reply categories, but use them as guardrails instead of fixed template selectors.
- Keep reaction recommendation and Korean-first response style.

## Implementation Changes

- Slack draft pipeline in `server/src/llm-service.js`
- Add thread-understanding helpers to extract topic, confirmed context, unresolved point, latest request, and deadline hints.
- Build summary from understanding output (1-2 sentences, no label-style listing).
- Generate fallback reply from understanding output (1-3 practical sentences, not meta-only).
- Add reply validation to reject meta-only model output and fall back to contextual local reply.

- OpenAI schema and prompt
- Extend Slack generation schema with `replyIntent` and `suggestedReply`.
- Force model to answer the latest mention directly, in Korean, within 1-3 sentences.
- Keep category + reaction recommendation, but allow per-thread custom reply text.

- Slack domain metadata in `server/src/domains/slack-mention-domain.js`
- Persist `replyIntent` in draft metadata alongside `replyCategory`, `requestedAction`, and `reactionName`.

- UI behavior
- Continue showing only summary + draft + reaction recommendation.
- Do not expose internal understanding structure in the detail screen.

## Output Contract

- Slack draft output fields:
- `summary`
- `requestedAction`
- `replyIntent`
- `suggestedReply`
- `replyCategory`
- `replyCategoryLabel`
- `reactionName`
- `provider`

## Test Plan

- `server/tests/llm-service.test.js`
- Context-aware summary and reply generation for each major category.
- Distinct responses for similar categories with different thread context.
- OpenAI path uses `suggestedReply` when valid.
- OpenAI meta-only reply is rejected and replaced by contextual fallback.

- `server/tests/slack-mention-domain.test.js`
- Generated summary/draft/reaction metadata persists correctly during poll.
- `replyIntent` is stored in draft metadata.
- Existing reply execution and reaction flow continue to work.

## Assumptions

- OpenAI-configured path is primary, local fallback is required for continuity.
- Default Slack answer style is concise and practical (1-3 sentences).
- Category guardrails remain active to keep response intent stable.
