import { AiRequestError, getJson, postJson } from '../net';
import {
  ChatAdapter,
  CompletionRequest,
  CompletionResult,
  ListModelsRequest,
  ToolCall,
  Turn,
} from '../types';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

type Part =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

function toContents(transcript: Turn[]): { role: 'user' | 'model'; parts: Part[] }[] {
  return transcript.map((turn) => {
    if (turn.role === 'user') {
      return { role: 'user' as const, parts: [{ text: turn.text }] };
    }
    if (turn.role === 'assistant') {
      const parts: Part[] = [];
      if (turn.text) parts.push({ text: turn.text });
      for (const call of turn.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.args } });
      }
      return { role: 'model' as const, parts };
    }
    return {
      role: 'user' as const,
      parts: turn.results.map((r) => ({
        functionResponse: { name: r.name, response: { result: r.content } },
      })),
    };
  });
}

export function createGoogleAdapter(): ChatAdapter {
  return {
    async listModels(req: ListModelsRequest): Promise<string[]> {
      const data = (await getJson(
        `${GEMINI_BASE_URL}?pageSize=1000`,
        { 'x-goog-api-key': req.apiKey },
        req.signal,
      )) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };

      if (!Array.isArray(data.models)) {
        throw new AiRequestError('The provider did not return a model list.');
      }
      return data.models
        // Embedding and other non-chat models are listed here too, and none of them can
        // answer a generateContent call.
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => m.name?.replace(/^models\//, ''))
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    },

    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const url = `${GEMINI_BASE_URL}/${encodeURIComponent(req.model)}:generateContent`;

      const body = {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: toContents(req.transcript),
        tools: [
          {
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          },
        ],
      };

      const data = (await postJson(
        url,
        { 'x-goog-api-key': req.apiKey },
        body,
        req.signal,
      )) as { candidates?: { content?: { parts?: Part[] } }[] };

      const parts = data.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) {
        // A blocked prompt comes back with no candidate parts at all.
        throw new AiRequestError('Gemini returned no content — the request may have been blocked.');
      }

      const text = parts
        .filter((p): p is { text: string } => 'text' in p)
        .map((p) => p.text)
        .join('\n');

      // Gemini matches results to calls by function name rather than by id, so the id is
      // synthesized here purely to satisfy the neutral transcript shape.
      const toolCalls: ToolCall[] = parts
        .filter((p): p is Extract<Part, { functionCall: unknown }> => 'functionCall' in p)
        .map((p, i) => ({
          id: `${p.functionCall.name}-${i}`,
          name: p.functionCall.name,
          args: p.functionCall.args ?? {},
        }));

      return { text, toolCalls };
    },
  };
}
