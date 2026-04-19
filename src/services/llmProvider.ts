import axios from 'axios';
import { LLMProvider, LLMMessage, LLMResponse } from '../types';

export const PROMPT_VERSION = 'v1';

// ─── Timeout wrapper ──────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`LLM call timed out after ${ms}ms`)), ms);
    promise.then(
      val => { clearTimeout(timer); resolve(val); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

// ─── Anthropic ────────────────────────────────────────────────────────────────

class AnthropicProvider implements LLMProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(messages: LLMMessage[], timeoutMs = 30000): Promise<LLMResponse> {
    const anthropicMessages = messages.map(m => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.map(part => {
            if (part.type === 'image') {
              return {
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: part.mimeType as 'image/jpeg' | 'image/png' | 'application/pdf',
                  data: part.imageBase64!,
                },
              };
            }
            return { type: 'text' as const, text: part.text! };
          })
        : m.content,
    }));

    try {
      const call = axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: this.model,
          max_tokens: 4096,
          messages: anthropicMessages,
        },
        {
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
        }
      );

      const response = await withTimeout(call, timeoutMs);
      const text: string = response.data.content
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('');

      return { text, rawResponse: response.data };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        console.error('[anthropic] API error:', JSON.stringify(err.response?.data, null, 2));
        throw new Error(err.response?.data?.error?.message || err.message);
      }
      throw err;
    }
  }
}

// ─── Google Gemini ────────────────────────────────────────────────────────────

class GoogleProvider implements LLMProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(messages: LLMMessage[], timeoutMs = 30000): Promise<LLMResponse> {
    console.log('[google] Sending request to Gemini...');

    const contents = messages.map(m => {
      const parts = Array.isArray(m.content)
        ? m.content.map(part => {
            if (part.type === 'image') {
              return {
                inlineData: {
                  mimeType: part.mimeType,
                  data: part.imageBase64,
                },
              };
            }
            return { text: part.text };
          })
        : [{ text: m.content as string }];

      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });

    try {
      const call = axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
        { contents },
        { headers: { 'content-type': 'application/json' } }
      );

      const response = await withTimeout(call, timeoutMs);
      console.log('[google] Response received');

      const text: string = response.data.candidates?.[0]?.content?.parts
        ?.filter((p: { text?: string }) => p.text)
        ?.map((p: { text: string }) => p.text)
        ?.join('') ?? '';

      return { text, rawResponse: response.data };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        console.error('[google] Gemini API error:', JSON.stringify(err.response?.data, null, 2));
        throw new Error(err.response?.data?.error?.message || err.message);
      }
      throw err;
    }
  }
}

// ─── Groq ─────────────────────────────────────────────────────────────────────

class GroqProvider implements LLMProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(messages: LLMMessage[], timeoutMs = 30000): Promise<LLMResponse> {
    const groqMessages = messages.map(m => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.map(part => {
            if (part.type === 'image') {
              return {
                type: 'image_url' as const,
                image_url: { url: `data:${part.mimeType};base64,${part.imageBase64}` },
              };
            }
            return { type: 'text' as const, text: part.text! };
          })
        : m.content,
    }));

    try {
      const call = axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model: this.model, max_tokens: 4096, messages: groqMessages },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
        }
      );

      const response = await withTimeout(call, timeoutMs);
      const text: string = response.data.choices?.[0]?.message?.content ?? '';
      return { text, rawResponse: response.data };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        console.error('[groq] API error:', JSON.stringify(err.response?.data, null, 2));
        throw new Error(err.response?.data?.error?.message || err.message);
      }
      throw err;
    }
  }
}

// ─── Mistral ──────────────────────────────────────────────────────────────────

class MistralProvider implements LLMProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(messages: LLMMessage[], timeoutMs = 30000): Promise<LLMResponse> {
    const mistralMessages = messages.map(m => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.map(part => {
            if (part.type === 'image') {
              return {
                type: 'image_url' as const,
                image_url: { url: `data:${part.mimeType};base64,${part.imageBase64}` },
              };
            }
            return { type: 'text' as const, text: part.text! };
          })
        : m.content,
    }));

    try {
      const call = axios.post(
        'https://api.mistral.ai/v1/chat/completions',
        { model: this.model, max_tokens: 4096, messages: mistralMessages },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
        }
      );

      const response = await withTimeout(call, timeoutMs);
      const text: string = response.data.choices?.[0]?.message?.content ?? '';
      return { text, rawResponse: response.data };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        console.error('[mistral] API error:', JSON.stringify(err.response?.data, null, 2));
        throw new Error(err.response?.data?.error?.message || err.message);
      }
      throw err;
    }
  }
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(messages: LLMMessage[], timeoutMs = 30000): Promise<LLMResponse> {
    const oaiMessages = messages.map(m => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.map(part => {
            if (part.type === 'image') {
              return {
                type: 'image_url' as const,
                image_url: { url: `data:${part.mimeType};base64,${part.imageBase64}` },
              };
            }
            return { type: 'text' as const, text: part.text! };
          })
        : m.content,
    }));

    try {
      const call = axios.post(
        'https://api.openai.com/v1/chat/completions',
        { model: this.model, max_tokens: 4096, messages: oaiMessages },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
        }
      );

      const response = await withTimeout(call, timeoutMs);
      const text: string = response.data.choices?.[0]?.message?.content ?? '';
      return { text, rawResponse: response.data };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        console.error('[openai] API error:', JSON.stringify(err.response?.data, null, 2));
        throw new Error(err.response?.data?.error?.message || err.message);
      }
      throw err;
    }
  }
}

// ─── Ollama (local) ───────────────────────────────────────────────────────────

class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private model: string;

  constructor(model: string) {
    this.baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.model = model;
  }

  async complete(messages: LLMMessage[], timeoutMs = 60000): Promise<LLMResponse> {
    const ollamaMessages = messages.map(m => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
        : m.content,
      images: Array.isArray(m.content)
        ? m.content.filter(p => p.type === 'image').map(p => p.imageBase64!)
        : undefined,
    }));

    try {
      const call = axios.post(
        `${this.baseUrl}/api/chat`,
        { model: this.model, messages: ollamaMessages, stream: false },
        { headers: { 'content-type': 'application/json' } }
      );

      const response = await withTimeout(call, timeoutMs);
      const text: string = response.data.message?.content ?? '';
      return { text, rawResponse: response.data };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        console.error('[ollama] API error:', JSON.stringify(err.response?.data, null, 2));
        throw new Error(err.response?.data?.error?.message || err.message);
      }
      throw err;
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createLLMProvider(): LLMProvider {
  const provider = process.env.LLM_PROVIDER?.toLowerCase() || 'anthropic';
  const model = process.env.LLM_MODEL || getDefaultModel(provider);
  const apiKey = process.env.LLM_API_KEY || '';

  switch (provider) {
    case 'anthropic': return new AnthropicProvider(apiKey, model);
    case 'google': return new GoogleProvider(apiKey, model);
    case 'groq': return new GroqProvider(apiKey, model);
    case 'mistral': return new MistralProvider(apiKey, model);
    case 'openai': return new OpenAIProvider(apiKey, model);
    case 'ollama': return new OllamaProvider(model);
    default: throw new Error(`Unknown LLM provider: ${provider}`);
  }
}

function getDefaultModel(provider: string): string {
  const defaults: Record<string, string> = {
    anthropic: 'claude-haiku-4-5-20251001',
    google: 'gemini-2.0-flash',
    groq: 'llama-3.2-11b-vision-preview',
    mistral: 'pixtral-12b-2409',
    openai: 'gpt-4o-mini',
    ollama: 'llava',
  };
  return defaults[provider] || 'claude-haiku-4-5-20251001';
}

export async function checkLLMHealth(): Promise<boolean> {
  try {
    const provider = createLLMProvider();
    await provider.complete([{ role: 'user', content: 'ping' }], 5000);
    return true;
  } catch {
    return false;
  }
}