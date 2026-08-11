import { TOGETHER_CARTESIA_SONIC_2_MODEL_ID } from './together-cartesia-sonic-2.metadata';
import { TOGETHER_ORPHEUS_MODEL_ID } from './together-orpheus.metadata';

export type TogetherTtsModelId =
  | typeof TOGETHER_ORPHEUS_MODEL_ID
  | typeof TOGETHER_CARTESIA_SONIC_2_MODEL_ID;

export interface TogetherTtsModelDefinition {
  model: TogetherTtsModelId;
}

export const TOGETHER_TTS_MODEL_DEFINITIONS = {
  [TOGETHER_ORPHEUS_MODEL_ID]: {
    model: TOGETHER_ORPHEUS_MODEL_ID,
  },
  [TOGETHER_CARTESIA_SONIC_2_MODEL_ID]: {
    model: TOGETHER_CARTESIA_SONIC_2_MODEL_ID,
  },
} as const satisfies Record<TogetherTtsModelId, TogetherTtsModelDefinition>;
