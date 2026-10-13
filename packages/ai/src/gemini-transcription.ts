import type {
  ProviderTranscriptOutput,
  TranscriptionInput,
  TranscriptionProvider,
} from '@comic-captioner/audio-engine';

const filesUrl =
  'https://generativelanguage.googleapis.com/upload/v1beta/files';
const interactionsUrl =
  'https://generativelanguage.googleapis.com/v1beta/interactions';

export class GeminiTranscriptionError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'GEMINI_NOT_CONFIGURED'
      | 'GEMINI_AUTHENTICATION'
      | 'GEMINI_QUOTA'
      | 'GEMINI_MODEL_NOT_FOUND'
      | 'GEMINI_INVALID_REQUEST'
      | 'GEMINI_UNSUPPORTED_AUDIO'
      | 'GEMINI_NETWORK'
      | 'GEMINI_UPSTREAM'
      | 'GEMINI_INVALID_RESPONSE' = 'GEMINI_UPSTREAM',
  ) {
    super(message);
    this.name = 'GeminiTranscriptionError';
  }
}

export interface GeminiTranscriptionProviderOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly fetch?: typeof fetch;
}

/** Server-only adapter; browser code must never import this module. */
export class GeminiTranscriptionProvider implements TranscriptionProvider {
  readonly providerId = 'gemini';
  readonly providerVersion: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: GeminiTranscriptionProviderOptions = {}) {
    this.#apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? '';
    this.providerVersion =
      options.model ??
      process.env.GEMINI_TRANSCRIPTION_MODEL ??
      'gemini-3.5-transcribe';
    this.#fetch = options.fetch ?? fetch;
  }

  async transcribe(input: TranscriptionInput): Promise<unknown> {
    if (!this.#apiKey)
      throw new GeminiTranscriptionError(
        'Gemini transcription is not configured on the API server.',
        'GEMINI_NOT_CONFIGURED',
      );
    if (input.asset.durationSeconds > 30 * 60)
      throw new GeminiTranscriptionError(
        'Word timestamps and diarization support audio up to 30 minutes.',
        'GEMINI_UNSUPPORTED_AUDIO',
      );
    const mimeType = audioMimeType(input.asset.format);
    let uploadedFile: { name: string; uri: string } | undefined;
    try {
      uploadedFile = await this.uploadAudio(input, mimeType);
      const response = await this.request(interactionsUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(input.signal ? { signal: input.signal } : {}),
        body: JSON.stringify({
          model: this.providerVersion,
          input: [
            { type: 'audio', uri: uploadedFile.uri, mime_type: mimeType },
          ],
          generation_config: {
            transcription_config: {
              mode: {
                type: 'verbatim',
                diarization_mode: 'speaker',
                timestamp_granularities: ['word'],
              },
            },
          },
        }),
      });
      let interaction = await jsonResponse(response);
      if (!isRecord(interaction))
        throw new GeminiTranscriptionError(
          'Gemini returned an invalid transcription response.',
          'GEMINI_INVALID_RESPONSE',
        );
      if (
        typeof interaction.id === 'string' &&
        interaction.status !== 'completed' &&
        interaction.status !== 'failed' &&
        interaction.status !== 'cancelled'
      ) {
        interaction = await this.waitForInteraction(
          interaction.id,
          input.signal,
        );
      }
      if (!isRecord(interaction) || interaction.status === 'failed')
        throw new GeminiTranscriptionError(
          'Gemini could not complete the transcription request.',
          'GEMINI_UPSTREAM',
        );
      return extractTranscript(interaction, input);
    } finally {
      if (uploadedFile) await this.deleteFile(uploadedFile.name);
    }
  }

  private async uploadAudio(
    input: TranscriptionInput,
    mimeType: string,
  ): Promise<{ name: string; uri: string }> {
    const start = await this.request(filesUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-upload-protocol': 'resumable',
        'x-goog-upload-command': 'start',
        'x-goog-upload-header-content-length': String(input.bytes.byteLength),
        'x-goog-upload-header-content-type': mimeType,
      },
      body: JSON.stringify({ file: { display_name: input.asset.filename } }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!start.ok)
      throw await providerError(start, 'Gemini audio upload could not start.');
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!uploadUrl)
      throw new GeminiTranscriptionError(
        'Gemini did not return an audio upload URL.',
        'GEMINI_INVALID_RESPONSE',
      );
    let parsed: unknown;
    try {
      const uploaded = await this.request(uploadUrl, {
        method: 'POST',
        headers: {
          'content-type': mimeType,
          'x-goog-upload-offset': '0',
          'x-goog-upload-command': 'upload, finalize',
        },
        body: input.bytes.slice().buffer as ArrayBuffer,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!uploaded.ok)
        throw await providerError(uploaded, 'Gemini audio upload failed.');
      parsed = await uploaded.json();
    } catch (error) {
      if (error instanceof GeminiTranscriptionError) throw error;
      throw networkError(error);
    }
    const file = isRecord(parsed) && isRecord(parsed.file) ? parsed.file : null;
    if (typeof file?.name !== 'string' || typeof file.uri !== 'string')
      throw new GeminiTranscriptionError(
        'Gemini returned incomplete uploaded-audio metadata.',
        'GEMINI_INVALID_RESPONSE',
      );
    return { name: file.name, uri: file.uri };
  }

  private async waitForInteraction(
    id: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (signal?.aborted) throw signal.reason;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const response = await this.request(
        `${interactionsUrl}/${encodeURIComponent(id)}`,
        { method: 'GET', ...(signal ? { signal } : {}) },
      );
      const interaction = await jsonResponse(response);
      if (!isRecord(interaction))
        throw new GeminiTranscriptionError(
          'Gemini returned an invalid transcription status.',
          'GEMINI_INVALID_RESPONSE',
        );
      if (interaction.status === 'completed') return interaction;
      if (interaction.status === 'failed' || interaction.status === 'cancelled')
        return interaction;
    }
    throw new GeminiTranscriptionError(
      'Gemini transcription took too long to complete.',
      'GEMINI_UPSTREAM',
    );
  }

  private async deleteFile(name: string): Promise<void> {
    try {
      await this.#fetch(
        `https://generativelanguage.googleapis.com/v1beta/${name}`,
        {
          method: 'DELETE',
          headers: { 'x-goog-api-key': this.#apiKey },
        },
      );
    } catch {
      // Uploaded files expire automatically; cleanup failure must not hide the transcript.
    }
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, {
        ...init,
        headers: {
          ...init.headers,
          'x-goog-api-key': this.#apiKey,
        },
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw networkError(error);
    }
  }
}

function extractTranscript(
  interaction: Record<string, unknown>,
  input: TranscriptionInput,
): ProviderTranscriptOutput {
  const words: Array<{
    text: unknown;
    startSeconds: unknown;
    endSeconds: unknown;
    speakerId: unknown;
  }> = [];
  let text =
    typeof interaction.output_text === 'string'
      ? interaction.output_text.trim()
      : '';
  if (Array.isArray(interaction.steps)) {
    for (const step of interaction.steps) {
      if (
        !isRecord(step) ||
        step.type !== 'model_output' ||
        !Array.isArray(step.content)
      )
        continue;
      for (const content of step.content) {
        if (!isRecord(content)) continue;
        if (!text && typeof content.text === 'string')
          text = content.text.trim();
        if (!Array.isArray(content.annotations)) continue;
        for (const annotation of content.annotations) {
          if (!isRecord(annotation) || annotation.type !== 'word_info')
            continue;
          words.push({
            text: annotation.text,
            startSeconds: parseSeconds(annotation.start_offset),
            endSeconds: parseSeconds(annotation.end_offset),
            speakerId: annotation.speaker ?? null,
          });
        }
      }
    }
  }
  if (!text || words.length === 0)
    throw new GeminiTranscriptionError(
      'Gemini response did not include transcript text and word timestamps.',
      'GEMINI_INVALID_RESPONSE',
    );
  const speakerIds = new Map<string, string>();
  const usedIds = new Set<string>();
  const internalId = (label: string): string => {
    const existing = speakerIds.get(label);
    if (existing) return existing;
    const base = label
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64);
    const candidateBase = base || `speaker_${speakerIds.size + 1}`;
    let id = candidateBase;
    let suffix = 2;
    while (usedIds.has(id)) {
      const ending = `_${suffix++}`;
      id = `${candidateBase.slice(0, 64 - ending.length)}${ending}`;
    }
    speakerIds.set(label, id);
    usedIds.add(id);
    return id;
  };
  const normalizedWords = words.map((word) => ({
    ...word,
    speakerId:
      typeof word.speakerId === 'string'
        ? internalId(word.speakerId)
        : word.speakerId,
  }));
  const speakers = [...speakerIds.entries()].map(([label, id]) => ({
    id,
    label: label.trim(),
  }));
  return {
    text,
    words: normalizedWords,
    speakers,
    inputHash: input.asset.sha256,
  };
}

async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok)
    throw await providerError(response, 'Gemini transcription failed.');
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new GeminiTranscriptionError(
      'Gemini returned malformed JSON.',
      'GEMINI_INVALID_RESPONSE',
    );
  }
}

async function providerError(
  response: Response,
  fallback: string,
): Promise<GeminiTranscriptionError> {
  let message = '';
  try {
    const value: unknown = await response.json();
    if (
      isRecord(value) &&
      isRecord(value.error) &&
      typeof value.error.message === 'string'
    )
      message = value.error.message.toLowerCase();
  } catch {
    /* Use HTTP status. */
  }
  const status = response.status;
  const code: GeminiTranscriptionError['code'] =
    /api.?key|credential|permission denied|authentication/.test(message) ||
    status === 401 ||
    status === 403
      ? 'GEMINI_AUTHENTICATION'
      : /quota|rate.?limit|resource exhausted/.test(message) || status === 429
        ? 'GEMINI_QUOTA'
        : /model.*not found|unknown model/.test(message) || status === 404
          ? 'GEMINI_MODEL_NOT_FOUND'
          : status === 400
            ? 'GEMINI_INVALID_REQUEST'
            : 'GEMINI_UPSTREAM';
  const safeMessage =
    code === 'GEMINI_AUTHENTICATION'
      ? 'Gemini rejected the server API key or its access.'
      : code === 'GEMINI_QUOTA'
        ? 'Gemini quota or rate limit was reached.'
        : code === 'GEMINI_MODEL_NOT_FOUND'
          ? 'Gemini could not find the configured transcription model.'
          : `${fallback} (HTTP ${status}).`;
  return new GeminiTranscriptionError(safeMessage, code);
}

function networkError(error: unknown): GeminiTranscriptionError {
  return new GeminiTranscriptionError(
    error instanceof Error
      ? `Could not reach Gemini: ${error.message}`
      : 'Could not reach Gemini.',
    'GEMINI_NETWORK',
  );
}

function audioMimeType(format: string): string {
  const types: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    webm: 'audio/webm',
  };
  const value = types[format.toLowerCase()];
  if (!value)
    throw new GeminiTranscriptionError(
      'Unsupported audio format.',
      'GEMINI_UNSUPPORTED_AUDIO',
    );
  return value;
}

function parseSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
