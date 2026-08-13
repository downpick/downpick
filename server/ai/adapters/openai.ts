import { AiRequestError, getJson, postJson, resolveBaseUrl } from '../net';
import {
  ChatAdapter,
  CompletionRequest,
  CompletionResult,
  ListModelsRequest,
  ToolCall,
  Turn,
} from '../types';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Azure pins its request/response shape to a dated API version. This is the GA version that
 * introduced structured tool calling; newer previews are backwards compatible with it.
 */
const AZURE_API_VERSION = '2024-10-21';

export type OpenAiFlavor = 'openai' | 'compatible' | 'azure';

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function toWireMessages(system: string, transcript: Turn[]): WireMessage[] {
  const messages: WireMessage[] = [{ role: 'system', content: system }];
  for (const turn of transcript) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.text });
    } else if (turn.role === 'assistant') {
      messages.push({
        role: 'assistant',
        // The API rejects an assistant message with neither content nor tool calls.
        content: turn.text || null,
        ...(turn.toolCalls.length > 0
          ? {
              tool_calls: turn.toolCalls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : {}),
      });
    } else {
      // Each tool result is its own message, keyed back to the call it answers.
      for (const result of turn.results) {
        messages.push({ role: 'tool', tool_call_id: result.id, content: result.content });
      }
    }
  }
  return messages;
}

function parseArgs(raw: string, toolName: string): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new AiRequestError(`The model sent malformed arguments for ${toolName}.`);
  }
}

/**
 * Serves OpenAI itself, any OpenAI-compatible endpoint (Ollama, vLLM, OpenRouter, …), and
 * Azure OpenAI — the three differ only in where the request goes and how it authenticates.
 */
export function createOpenAiAdapter(flavor: OpenAiFlavor): ChatAdapter {
  return {
    async listModels(req: ListModelsRequest): Promise<string[]> {
      let url: string;
      const headers: Record<string, string> = {};

      if (flavor === 'azure') {
        // Azure enumerates deployments rather than models, and a data-plane key is often
        // not entitled to. When it 403s, the error reaches the user and they type the
        // deployment name instead.
        url = `${resolveBaseUrl(req.baseUrl ?? '')}/openai/deployments?api-version=${AZURE_API_VERSION}`;
        headers['api-key'] = req.apiKey;
      } else {
        const base = flavor === 'compatible' ? resolveBaseUrl(req.baseUrl ?? '') : OPENAI_BASE_URL;
        url = `${base}/models`;
        headers.Authorization = `Bearer ${req.apiKey}`;
      }

      const data = (await getJson(url, headers, req.signal)) as { data?: { id?: string }[] };
      if (!Array.isArray(data.data)) {
        throw new AiRequestError('The provider did not return a model list.');
      }
      return data.data
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    },

    async complete(req: CompletionRequest): Promise<CompletionResult> {
      let url: string;
      const headers: Record<string, string> = {};

      if (flavor === 'azure') {
        const base = resolveBaseUrl(req.baseUrl ?? '');
        // The model id doubles as the deployment name on Azure.
        url = `${base}/openai/deployments/${encodeURIComponent(req.model)}/chat/completions?api-version=${AZURE_API_VERSION}`;
        headers['api-key'] = req.apiKey;
      } else {
        const base = flavor === 'compatible' ? resolveBaseUrl(req.baseUrl ?? '') : OPENAI_BASE_URL;
        url = `${base}/chat/completions`;
        headers.Authorization = `Bearer ${req.apiKey}`;
      }

      const body = {
        model: req.model,
        messages: toWireMessages(req.system, req.transcript),
        tools: req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      };

      const data = (await postJson(url, headers, body, req.signal)) as {
        choices?: { message?: WireMessage }[];
      };

      const message = data.choices?.[0]?.message;
      if (!message) {
        throw new AiRequestError('The provider returned a response with no message.');
      }

      const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        args: parseArgs(c.function.arguments, c.function.name),
      }));

      return { text: message.content ?? '', toolCalls };
    },
  };
}
