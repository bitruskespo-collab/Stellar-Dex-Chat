/**
 * Model Provider Adapter & Controlled Failover
 * Addresses Issue #77: Reduce coupling to one generative AI SDK and allow service recovery
 * without changing transaction policy or message semantics.
 */

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
}

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelResponse {
  content: string;
  provider: string;
  usage?: ModelUsage;
  latencyMs: number;
}

export type NormalizedErrorCode =
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'CONTENT_FILTERED'
  | 'STRUCTURED_OUTPUT_PARSE_ERROR'
  | 'AUTH_FAILURE'
  | 'PROVIDER_UNAVAILABLE';

export class ModelAdapterError extends Error {
  public code: NormalizedErrorCode;
  public provider: string;
  public isRetryable: boolean;

  constructor(code: NormalizedErrorCode, provider: string, message: string, isRetryable: boolean = false) {
    super(`[${provider}] ${code}: ${message}`);
    this.name = 'ModelAdapterError';
    this.code = code;
    this.provider = provider;
    this.isRetryable = isRetryable;
  }
}

export interface ModelProvider {
  id: string;
  name: string;
  isEnabled: boolean;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export class ModelRouter {
  private primaryProvider: ModelProvider;
  private fallbackProvider?: ModelProvider;
  private fallbackEnabled: boolean = false;

  constructor(primary: ModelProvider, fallback?: ModelProvider, enableFallback: boolean = false) {
    this.primaryProvider = primary;
    this.fallbackProvider = fallback;
    this.fallbackEnabled = enableFallback;
  }

  public setFallbackEnabled(enabled: boolean): void {
    this.fallbackEnabled = enabled;
  }

  /**
   * Execute model request with controlled failover.
   * Fallback is only invoked if explicitly configured and primary encounters a retryable outage.
   */
  public async execute(request: ModelRequest): Promise<ModelResponse> {
    try {
      return await this.primaryProvider.complete(request);
    } catch (err: unknown) {
      const isRetryableError = err instanceof ModelAdapterError && err.isRetryable;

      if (this.fallbackEnabled && this.fallbackProvider && this.fallbackProvider.isEnabled && isRetryableError) {
        console.warn(`Primary provider '${this.primaryProvider.id}' failed. Initiating controlled failover to '${this.fallbackProvider.id}'`);
        return await this.fallbackProvider.complete(request);
      }

      throw err;
    }
  }
}
