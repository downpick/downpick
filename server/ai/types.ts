/** JSON Schema for a tool's arguments. Kept loose — each adapter passes it through. */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  /** Provider-assigned id, echoed back with the result so the model can match them up. */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  /** Already-serialized content. Tools return text, not objects, so adapters stay simple. */
  content: string;
}

/**
 * Provider-neutral transcript. Each adapter translates this into its own wire shape; the
 * agent loop never learns which provider it is talking to.
 */
export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] };

export interface CompletionRequest {
  apiKey: string;
  /** Already validated by resolveBaseUrl() when the provider kind requires one. */
  baseUrl?: string;
  model: string;
  system: string;
  transcript: Turn[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
}

export interface ListModelsRequest {
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
}

export interface ChatAdapter {
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /**
   * Asks the provider which models this key can actually use.
   *
   * Every provider exposes something for this, but not every deployment answers: an Azure
   * data-plane key is often not permitted to enumerate deployments, and a homemade
   * OpenAI-compatible server may simply not implement /models. Failure is expected and
   * surfaces as an AiRequestError, which the UI turns into "type the id yourself".
   */
  listModels(req: ListModelsRequest): Promise<string[]>;
}
