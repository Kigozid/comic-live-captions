import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  AudioEngine,
  type AudioImportResult,
  type ClockSnapshot,
  type Transcript,
} from '@comic-captioner/audio-engine';
import { requestAssist } from './assist-client.js';
import type { AssistProposal } from './assist-client.js';
import { refineTranscriptWordTimes } from './engine-adapters.js';

const emptySnapshot: ClockSnapshot = Object.freeze({
  positionSeconds: 0,
  durationSeconds: 0,
  playbackRate: 1,
  status: 'empty',
});

export interface AudioPlaybackControls {
  readonly toggle: () => Promise<void>;
  readonly seek: (timeSeconds: number) => void;
  readonly import: () => void;
  readonly transcribe: () => Promise<Transcript | null>;
}

export function AudioWorkspace({
  onTranscriptChange,
  onAudioAsset,
  initialAudioFile,
  initialTranscript,
  onClockChange,
  seekRequest,
  onAudioControls,
}: {
  readonly onTranscriptChange?: (transcript: Transcript | null) => void;
  readonly onAudioAsset?: (asset: {
    readonly metadata: AudioImportResult['asset']['metadata'];
    readonly blob: Blob;
  }) => void;
  readonly initialAudioFile?: File | null;
  readonly initialTranscript?: Transcript | null;
  readonly onClockChange?: (snapshot: ClockSnapshot) => void;
  readonly seekRequest?: {
    readonly time: number;
    readonly revision: number;
  } | null;
  readonly onAudioControls?: (controls: AudioPlaybackControls | null) => void;
}) {
  const [engine, setEngine] = useState<AudioEngine | null>(null);
  const [assetResult, setAssetResult] = useState<AudioImportResult | null>(
    null,
  );
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [transcriptUndo, setTranscriptUndo] = useState<Transcript[]>([]);
  const [transcriptAssists, setTranscriptAssists] = useState<
    Record<string, AssistProposal>
  >({});
  const [assistBusyId, setAssistBusyId] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const togglePlaybackRef = useRef<() => Promise<void>>(async () => undefined);
  const transcribeRef = useRef<() => Promise<Transcript | null>>(
    async () => null,
  );
  const importFileRef = useRef<(file?: File) => Promise<void>>(
    async () => undefined,
  );
  const callbacksRef = useRef({
    onTranscriptChange,
    onAudioAsset,
    onClockChange,
    onAudioControls,
  });
  callbacksRef.current = {
    onTranscriptChange,
    onAudioAsset,
    onClockChange,
    onAudioControls,
  };
  const snapshot = useSyncExternalStore(
    engine?.clock.subscribe ?? noopSubscribe,
    engine?.clock.getSnapshot ?? (() => emptySnapshot),
    () => emptySnapshot,
  );

  useEffect(() => {
    callbacksRef.current.onTranscriptChange?.(transcript);
  }, [transcript]);

  useEffect(() => {
    callbacksRef.current.onClockChange?.(snapshot);
  }, [snapshot]);

  useEffect(() => {
    if (seekRequest) engine?.seek(seekRequest.time);
  }, [engine, seekRequest]);

  useEffect(() => {
    try {
      const audioEngine = new AudioEngine();
      setEngine(audioEngine);
      return () => {
        void audioEngine.dispose();
      };
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Audio playback is unavailable.',
      );
    }
  }, []);

  async function importFile(file?: File) {
    if (!file || !engine) return;
    setBusy(true);
    setError(null);
    try {
      const result = await engine.importFile(file);
      setAssetResult(result);
      const sourceBytes = result.asset.getBytes();
      callbacksRef.current.onAudioAsset?.({
        metadata: result.asset.metadata,
        blob: new Blob([sourceBytes.buffer as ArrayBuffer], {
          type: result.asset.metadata.mediaType,
        }),
      });
      setTranscript(null);
      setTranscriptUndo([]);
      setTranscriptAssists({});
      setSpeed(1);
      engine.setPlaybackRate(1);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'This audio file could not be imported.',
      );
    } finally {
      setBusy(false);
    }
  }

  importFileRef.current = importFile;

  useEffect(() => {
    if (initialAudioFile && engine)
      void importFileRef.current(initialAudioFile);
  }, [initialAudioFile, engine]);

  useEffect(() => {
    setTranscript(initialTranscript ?? null);
  }, [initialTranscript]);

  async function requestTranscription(): Promise<Transcript | null> {
    if (!engine?.asset) return null;
    setTranscribing(true);
    setError(null);
    try {
      const metadata = engine.asset.metadata;
      const bytes = engine.asset.getBytes();
      const form = new FormData();
      form.set(
        'audio',
        new Blob([bytes.buffer as ArrayBuffer], { type: metadata.mediaType }),
        metadata.filename,
      );
      form.set('metadata', JSON.stringify(metadata));
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        body: form,
      });
      const result = (await response.json()) as {
        readonly transcript?: Transcript;
        readonly error?: { readonly message?: string };
      };
      if (!response.ok || !result.transcript)
        throw new Error(
          result.error?.message ?? 'The transcript could not be generated.',
        );
      // Prefer wav2vec2 CTC word timings when the API/weights are available.
      // Failure keeps the provider's word times so review is never blocked.
      const refined = await refineTranscriptWordTimes(result.transcript, {
        audioBytes: bytes,
        sampleRateHz: metadata.sampleRateHz,
      });
      setTranscript(refined.transcript);
      setTranscriptUndo([]);
      setTranscriptAssists({});
      return refined.transcript;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The transcript could not be generated.',
      );
      return null;
    } finally {
      setTranscribing(false);
    }
  }

  transcribeRef.current = requestTranscription;

  async function togglePlayback() {
    if (!engine) return;
    try {
      if (snapshot.status === 'playing') engine.pause();
      else await engine.play();
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Audio playback failed.',
      );
    }
  }

  togglePlaybackRef.current = togglePlayback;

  useEffect(() => {
    if (!engine) return;
    callbacksRef.current.onAudioControls?.({
      toggle: () => togglePlaybackRef.current(),
      seek: (timeSeconds) => engine.seek(timeSeconds),
      import: () => inputRef.current?.click(),
      transcribe: () => transcribeRef.current(),
    });
    return () => callbacksRef.current.onAudioControls?.(null);
  }, [engine]);

  function changeVolume(value: number) {
    setVolume(value);
    engine?.setVolume(value);
  }

  function changeSpeed(value: number) {
    setSpeed(value);
    engine?.setPlaybackRate(value);
  }

  async function suggestTranscriptCorrection(segmentId: string) {
    if (!transcript) return;
    const segment = transcript.segments.find((item) => item.id === segmentId);
    if (!segment) return;
    setAssistBusyId(segmentId);
    setError(null);
    try {
      const proposal = await requestAssist({
        task: 'transcription-correction',
        targetId: segment.id,
        context: {
          text: segment.text,
          speakerId: segment.speakerId,
          neighboringSegments: transcript.segments
            .filter((item) => item.id !== segment.id)
            .slice(
              Math.max(0, transcript.segments.indexOf(segment) - 1),
              transcript.segments.indexOf(segment) + 2,
            )
            .map((item) => ({ text: item.text, speakerId: item.speakerId })),
        },
      });
      setTranscriptAssists((current) => ({
        ...current,
        [segment.id]: proposal,
      }));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Transcription correction failed.',
      );
    } finally {
      setAssistBusyId(null);
    }
  }

  function approveTranscriptCorrection(segmentId: string) {
    const proposal = transcriptAssists[segmentId];
    if (
      !transcript ||
      !proposal ||
      proposal.task !== 'transcription-correction' ||
      !('text' in proposal.suggestion)
    )
      return;
    const correctedText = proposal.suggestion.text;
    setTranscriptUndo((past) => [...past, transcript]);
    setTranscript((current) =>
      current
        ? Object.freeze({
            ...current,
            segments: Object.freeze(
              current.segments.map((segment) =>
                segment.id === segmentId
                  ? Object.freeze({
                      ...segment,
                      text: correctedText,
                    })
                  : segment,
              ),
            ),
            text: current.segments
              .map((segment) =>
                segment.id === segmentId ? correctedText : segment.text,
              )
              .join(' '),
            reviewStatus: 'edited',
            revision: current.revision + 1,
          })
        : current,
    );
    setTranscriptAssists((current) => {
      const next = { ...current };
      delete next[segmentId];
      return next;
    });
  }

  function undoTranscriptCorrection() {
    const previous = transcriptUndo.at(-1);
    if (!previous) return;
    setTranscript(previous);
    setTranscriptUndo((past) => past.slice(0, -1));
  }

  const waveform = assetResult?.waveform.bins;
  const displayedBars = waveform
    ? Array.from({ length: 180 }, (_, index) => {
        const binStart = Math.floor((index / 180) * waveform.length);
        const binEnd = Math.max(
          binStart + 1,
          Math.floor(((index + 1) / 180) * waveform.length),
        );
        let peak = 0;
        for (let bin = binStart; bin < binEnd; bin += 1)
          peak = Math.max(peak, waveform[bin] ?? 0);
        return peak;
      })
    : [];

  return (
    <section
      className="mt-5 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6"
      aria-label="Audio workspace"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-stone-900">Audio track</h2>
          <p className="mt-1 text-sm text-stone-600">
            Import dialogue audio and inspect its waveform and timing.
          </p>
        </div>
        <div>
          <button
            className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-800 disabled:cursor-wait disabled:opacity-50"
            disabled={busy || !engine}
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            {busy
              ? 'Importing audio…'
              : assetResult
                ? 'Replace audio'
                : 'Import audio'}
          </button>
          <input
            accept="audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg,audio/webm,.mp3,.wav,.m4a,.aac,.ogg,.webm"
            className="sr-only"
            onChange={(event) => {
              void importFile(event.currentTarget.files?.[0]);
              event.currentTarget.value = '';
            }}
            ref={inputRef}
            type="file"
          />
        </div>
      </div>

      {assetResult && (
        <>
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-stone-500">File</dt>
              <dd
                className="truncate font-medium"
                title={assetResult.asset.metadata.filename}
              >
                {assetResult.asset.metadata.filename}
              </dd>
            </div>
            <div>
              <dt className="text-stone-500">Format</dt>
              <dd className="font-medium">
                {assetResult.asset.metadata.format.toUpperCase()}
              </dd>
            </div>
            <div>
              <dt className="text-stone-500">Duration</dt>
              <dd className="font-medium">
                {formatTime(assetResult.asset.metadata.durationSeconds)}
              </dd>
            </div>
            <div>
              <dt className="text-stone-500">Audio</dt>
              <dd className="font-medium">
                {assetResult.asset.metadata.sampleRateHz.toLocaleString()} Hz ·{' '}
                {assetResult.asset.metadata.channelCount} ch
              </dd>
            </div>
          </dl>
          <div
            className="mt-5 flex h-20 items-center gap-px overflow-hidden rounded-lg bg-stone-950 px-2"
            role="img"
            aria-label="Audio waveform"
          >
            {displayedBars.map((peak, index) => (
              <span
                className="min-w-0 flex-1 rounded-full bg-indigo-300"
                key={index}
                style={{
                  height: `${Math.max(3, peak * 100)}%`,
                  opacity: 0.65 + peak * 0.35,
                }}
              />
            ))}
          </div>
          <input
            aria-label="Audio position"
            className="mt-4 w-full accent-indigo-700"
            max={snapshot.durationSeconds}
            min={0}
            onChange={(event) =>
              engine?.seek(Number(event.currentTarget.value))
            }
            step="0.01"
            type="range"
            value={snapshot.positionSeconds}
          />
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <button
                aria-label={
                  snapshot.status === 'playing' ? 'Pause audio' : 'Play audio'
                }
                className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-700"
                onClick={() => void togglePlayback()}
                type="button"
              >
                {snapshot.status === 'playing' ? 'Pause' : 'Play'}
              </button>
              <span className="text-sm tabular-nums text-stone-600">
                {formatTime(snapshot.positionSeconds)} /{' '}
                {formatTime(snapshot.durationSeconds)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-stone-600">
                Volume
                <input
                  aria-label="Audio volume"
                  className="w-24 accent-indigo-700"
                  max="1"
                  min="0"
                  onChange={(event) =>
                    changeVolume(Number(event.currentTarget.value))
                  }
                  step="0.01"
                  type="range"
                  value={volume}
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-stone-600">
                Speed
                <select
                  aria-label="Playback speed"
                  className="rounded-md border border-stone-300 bg-white px-2 py-1"
                  onChange={(event) =>
                    changeSpeed(Number(event.currentTarget.value))
                  }
                  value={speed}
                >
                  {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}×
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          <p className="mt-2 text-xs text-stone-500">
            Timebase: {assetResult.asset.metadata.timebase.id} · seconds ·{' '}
            {assetResult.asset.metadata.frameCount.toLocaleString()} decoded
            samples per channel.
          </p>
          <button
            className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-800 hover:bg-indigo-100 disabled:cursor-wait disabled:opacity-50"
            disabled={transcribing}
            onClick={() => void requestTranscription()}
            type="button"
          >
            {transcribing
              ? 'Transcribing with Gemini…'
              : transcript
                ? 'Run transcription again'
                : 'Generate transcript with Gemini'}
          </button>
        </>
      )}
      {transcript && (
        <div className="mt-5 border-t border-stone-200 pt-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-stone-900">
                Transcript proposal
              </h3>
              <p className="text-sm text-stone-500">
                Review the recognized dialogue and timing. Correct it before
                using the transcript.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="rounded-md border border-stone-300 px-2 py-1 text-xs disabled:opacity-40"
                disabled={!transcriptUndo.length}
                onClick={undoTranscriptCorrection}
                type="button"
              >
                Undo AI edit
              </button>
              <span className="text-xs font-medium text-amber-800">
                {transcript.reviewStatus === 'accepted'
                  ? 'Accepted'
                  : transcript.reviewStatus === 'edited'
                    ? 'Edited · review pending'
                    : 'Needs review'}
              </span>
              {transcript.reviewStatus !== 'accepted' && (
                <button
                  className="rounded-md bg-indigo-700 px-3 py-1.5 text-sm font-semibold text-white"
                  onClick={() =>
                    setTranscript((current) =>
                      current
                        ? Object.freeze({
                            ...current,
                            reviewStatus: 'accepted',
                            revision: current.revision + 1,
                          })
                        : current,
                    )
                  }
                  type="button"
                >
                  Accept transcript
                </button>
              )}
            </div>
          </div>
          <div className="max-h-96 space-y-3 overflow-y-auto">
            {transcript.segments.map((segment) => (
              <div className="rounded-lg bg-stone-50 p-3" key={segment.id}>
                <div className="grid gap-2 sm:grid-cols-[7rem_1fr]">
                  <span className="text-xs text-stone-500">
                    {formatTime(segment.interval.start.value)}–
                    {formatTime(segment.interval.end.value)}
                    {segment.speakerId ? ` · ${segment.speakerId}` : ''}
                  </span>
                  <textarea
                    aria-label={`Transcript segment at ${formatTime(segment.interval.start.value)}`}
                    className="min-h-16 w-full resize-y rounded-md border border-stone-200 bg-white px-3 py-2 text-sm"
                    onChange={(event) => {
                      const text = event.currentTarget.value;
                      setTranscript((current) => {
                        if (!current) return current;
                        const segments = current.segments.map((entry) =>
                          entry.id === segment.id
                            ? Object.freeze({
                                ...entry,
                                text,
                              })
                            : entry,
                        );
                        setTranscriptAssists((current) => {
                          const next = { ...current };
                          delete next[segment.id];
                          return next;
                        });
                        return Object.freeze({
                          ...current,
                          text: segments.map((entry) => entry.text).join(' '),
                          segments: Object.freeze(segments),
                          reviewStatus: 'edited',
                          revision: current.revision + 1,
                        });
                      });
                    }}
                    value={segment.text}
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    className="rounded border border-stone-300 px-2 py-1 text-xs"
                    onClick={() => {
                      setTranscript((current) => {
                        if (!current) return current;
                        const segments = current.segments.filter(
                          (entry) => entry.id !== segment.id,
                        );
                        return segments.length
                          ? Object.freeze({
                              ...current,
                              text: segments
                                .map((entry) => entry.text)
                                .join(' '),
                              segments: Object.freeze(segments),
                              reviewStatus: 'edited' as const,
                              revision: current.revision + 1,
                            })
                          : null;
                      });
                      setTranscriptAssists((current) => {
                        const next = { ...current };
                        delete next[segment.id];
                        return next;
                      });
                    }}
                    type="button"
                  >
                    Remove segment
                  </button>
                  <button
                    className="rounded border border-indigo-200 px-2 py-1 text-xs text-indigo-800 disabled:opacity-50"
                    disabled={assistBusyId === segment.id}
                    onClick={() => void suggestTranscriptCorrection(segment.id)}
                    type="button"
                  >
                    {assistBusyId === segment.id
                      ? 'Analyzing…'
                      : 'Suggest correction with Gemini'}
                  </button>
                  {transcriptAssists[segment.id] && (
                    <>
                      <span className="text-xs text-stone-600">
                        Suggestion (
                        {Math.round(
                          transcriptAssists[segment.id]!.confidence * 100,
                        )}
                        %):{' '}
                        {suggestionText(
                          transcriptAssists[segment.id]!.suggestion,
                        )}
                      </span>
                      <button
                        className="rounded bg-indigo-700 px-2 py-1 text-xs text-white"
                        onClick={() => approveTranscriptCorrection(segment.id)}
                        type="button"
                      >
                        Approve · undoable
                      </button>
                      <button
                        className="rounded border border-stone-300 px-2 py-1 text-xs"
                        onClick={() =>
                          setTranscriptAssists((current) => {
                            const next = { ...current };
                            delete next[segment.id];
                            return next;
                          })
                        }
                        type="button"
                      >
                        Reject
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {error && (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function noopSubscribe(): () => void {
  return () => undefined;
}

function suggestionText(suggestion: AssistProposal['suggestion']): string {
  return 'text' in suggestion ? suggestion.text : '';
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}
