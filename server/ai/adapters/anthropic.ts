import { AiRequestError, getJson, postJson } from '../net';
import {
  ChatAdapter,
  CompletionRequest,
  CompletionResult,
  ListModelsRequest,
  ToolCall,
  Turn,
} from '../types';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1000';
const ANTHROPIC_VERSION = '2023-06-01';

/** The Messages API requires an explicit cap; schema answers are short, so this is ample. */
const MAX_TOKENS = 4096;

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

function toWireMessages(transcript: Turn[]): { role: 'user' | 'assistant'; content: ContentBlock[] }[] {
  return transcript.map((turn) => {
    if (turn.role === 'user') {
      return { role: 'user' as const, content: [{ type: 'text' as const, text: turn.text }] };
    }
    if (turn.role === 'assistant') {
      const content: ContentBlock[] = [];
      if (turn.text) content.push({ type: 'text', text: turn.text });
      for (const call of turn.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      }
      return { role: 'assistant' as const, content };
    }
    // Tool results come back as a user turn — that is where the API expects them.
    return {
      role: 'user' as const,
      content: turn.results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.id,
        content: r.content,
      })),
    };
  });
}

export function createAnthropicAdapter(): ChatAdapter {
  return {
    async listModels(req: ListModelsRequest): Promise<string[]> {
      const data = (await getJson(
        ANTHROPIC_MODELS_URL,
        { 'x-api-key': req.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        req.signal,
      )) as { data?: { id?: string }[] };

      if (!Array.isArray(data.data)) {
        throw new AiRequestError('The provider did not return a model list.');
      }
      return data.data
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    },

    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const body = {
        model: req.model,
        max_tokens: MAX_TOKENS,
        system: req.system,
        messages: toWireMessages(req.transcript),
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
      };

      const data = (await postJson(
        ANTHROPIC_URL,
        {
          'x-api-key': req.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body,
        req.signal,
      )) as { content?: ContentBlock[] };

      const blocks = data.content;
      if (!Array.isArray(blocks)) {
        throw new AiRequestError('The provider returned a response with no content.');
      }

      const text = blocks
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

      const toolCalls: ToolCall[] = blocks
        .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));

      return { text, toolCalls };
    },
  };
}
