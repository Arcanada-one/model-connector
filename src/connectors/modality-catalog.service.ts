import { Injectable } from '@nestjs/common';

import {
  buildDerivedTags,
  entryMatchesFilters,
  type CatalogFilters,
  type CatalogModelEntry,
  type ModelModality,
} from './dto/catalog.dto';
import { IMAGE_CAPABILITIES } from './image-generation/capabilities';

// ─── CONN-0232 — non-chat modality completeness ──────────────────────────────
//
// WHY THIS EXISTS: getCatalog() in ConnectorsService only iterates connectors
// registered via ConnectorsService.register(), and only chat connectors (+ the
// embedding connector) are registered there. Image-generation connectors
// implement a different execute contract, STT connectors implement the separate
// ISttConnector, and TTS is a proxy to Transcribator — none are IConnector, so
// none appear in the chat catalog. That is the verified structural root cause of
// "too few models" (research R7, datarim/insights/CONN-0232-data-sources.md).
//
// This service surfaces those families as catalog entries WITHOUT forcing them
// through IConnector. Every model id below is sourced — image-gen from the
// already-curated, dated IMAGE_CAPABILITIES map; STT from each connector's own
// hard-coded default model (cited file:line). NO id is invented and NO live
// provider call is made (anti-fabrication hard rule).

/**
 * STT families. Each `model` is the connector's own hard-coded default model
 * id — the cited source is the connector file, so this is not an external claim.
 * `// source:` points at the verbatim literal in the connector.
 */
const STT_FAMILY: ReadonlyArray<{ connector: string; model: string; source: string }> = [
  {
    connector: 'assemblyai-stt',
    model: 'universal-2',
    source: 'src/speech/stt/assemblyai-stt.connector.ts:28',
  },
  {
    connector: 'deepgram-stt',
    model: 'nova-3',
    source: 'src/speech/stt/deepgram-stt.connector.ts:16',
  },
  {
    connector: 'groq-stt',
    model: 'whisper-large-v3',
    source: 'src/speech/stt/groq-stt.connector.ts:15',
  },
  {
    connector: 'local-whisper',
    model: 'whisper-large-v3',
    source: 'src/speech/stt/local-whisper-stt.connector.ts:13',
  },
  {
    connector: 'openai-stt',
    model: 'whisper-1',
    source: 'src/speech/stt/openai-stt.connector.ts:19',
  },
];

// Real invocation paths (cited from controllers) — keeps `routing.endpoint`
// honest so non-chat families are not misrepresented as the chat /execute route.
const ENDPOINT_IMAGE = '/images/generate'; // connectors.controller.ts:150
const ENDPOINT_STT = '/v1/speech/stt'; // src/speech/speech.controller.ts:81
const ENDPOINT_TTS = '/v1/speech/tts'; // src/speech/speech.controller.ts:45

const NO_CAPS = {
  supportsStreaming: false,
  supportsJsonSchema: false,
  supportsTools: false,
} as const;

function makeEntry(opts: {
  connector: string;
  model: string;
  modality: ModelModality;
  endpoint: string;
  available: boolean;
}): CatalogModelEntry {
  const free = false; // none of these families is free-tier; price model differs
  const cheap = false;
  return {
    connector: opts.connector,
    model: opts.model,
    modality: opts.modality,
    tags: buildDerivedTags({ modality: opts.modality, free, cheap, capabilities: NO_CAPS }),
    free,
    cheap,
    // Per-image / per-second pricing is not a multiplier — never invent one.
    priceMultiplier: null,
    // CONN-0238 — these static families publish no machine per-token price/context.
    pricing: null,
    contextWindow: null,
    maxOutputTokens: null,
    rateLimits: null,
    capabilities: { ...NO_CAPS },
    routing: { connector: opts.connector, model: opts.model, endpoint: opts.endpoint },
    available: opts.available,
  };
}

/**
 * Surfaces the non-chat model families (image-generation, speech-to-text,
 * text-to-speech) in the catalog. Pure + deterministic — no I/O, no live calls.
 */
@Injectable()
export class ModalityCatalogService {
  /** All static modality entries, before filtering. */
  getEntries(): CatalogModelEntry[] {
    const entries: CatalogModelEntry[] = [];

    // ── image_generation — from the curated, dated IMAGE_CAPABILITIES map ──
    for (const cap of Object.values(IMAGE_CAPABILITIES)) {
      entries.push(
        makeEntry({
          connector: cap.provider,
          model: cap.modelId,
          modality: 'image_generation',
          endpoint: ENDPOINT_IMAGE,
          // Reflects curated provisioning intent (IMAGE_CAPABILITIES.enabledByDefault),
          // not a live probe — static catalog makes no provider call.
          available: cap.enabledByDefault,
        }),
      );
    }

    // ── speech_to_text — each connector's own cited default model ──
    for (const stt of STT_FAMILY) {
      entries.push(
        makeEntry({
          connector: stt.connector,
          model: stt.model,
          modality: 'speech_to_text',
          endpoint: ENDPOINT_STT,
          available: true, // connector wired in SpeechModule; callable if provisioned
        }),
      );
    }

    // ── text_to_speech — ONE proxy route, not an invented native model list ──
    // MC proxies TTS to the downstream Transcribator service, which selects the
    // actual voice/model. We surface a single routing entry; `model: 'tts'` is a
    // family marker, not a fabricated provider model id.
    entries.push(
      makeEntry({
        connector: 'tts',
        model: 'tts',
        modality: 'text_to_speech',
        endpoint: ENDPOINT_TTS,
        available: true,
      }),
    );

    return entries;
  }

  /** Static entries that pass the given catalog filters. */
  getFilteredEntries(filters: CatalogFilters): CatalogModelEntry[] {
    return this.getEntries().filter((e) => entryMatchesFilters(e, filters));
  }
}
