export const SCORE_TYPES = [
  'SCORE_TYPE_UNSPECIFIED',
  'PROBABILITY',
  'STD_DEV_SCORE',
  'PERCENTILE',
  'RAW',
] as const;

export type ScoreType = (typeof SCORE_TYPES)[number];

export const TEXT_TYPES = ['TEXT_TYPE_UNSPECIFIED', 'PLAIN_TEXT', 'HTML'] as const;
export type TextType = (typeof TEXT_TYPES)[number];

export interface TextEntry {
  text: string;
  type?: TextType;
}

export interface AttributeParameters {
  scoreThreshold?: number;
  scoreType?: ScoreType;
}

export interface ArticleAndParentComment {
  article?: TextEntry;
  parentComment?: TextEntry;
}

export type AnalyzeContext =
  | { entries: TextEntry[]; articleAndParentComment?: never }
  | { entries?: never; articleAndParentComment: ArticleAndParentComment };

export interface AnalyzeCommentInput {
  comment: TextEntry;
  requestedAttributes: { TOXICITY: AttributeParameters };
  languages?: string[];
  context?: AnalyzeContext;
  doNotStore?: boolean;
  spanAnnotations?: boolean;
  clientToken?: string;
  communityId?: string;
  sessionId?: string;
}

export interface PerspectiveTransportRequest {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly redirect: 'error';
  readonly timeoutMs: number;
}

export interface PerspectiveTransportResponse {
  readonly status: number;
  readonly contentType: string;
  readonly bodyBytes: number;
  readonly body: unknown;
}

export type PerspectiveTransport = (
  request: Readonly<PerspectiveTransportRequest>,
) => Promise<PerspectiveTransportResponse>;

export interface GooglePerspectiveConnectorOptions {
  apiKey: string;
  transport: PerspectiveTransport;
  now: () => Date;
  timeoutMs?: number;
  allowProviderStorage?: boolean;
}

export interface PerspectiveScore {
  value: number;
  type?: ScoreType;
}

export interface PerspectiveSpanScore {
  begin?: number;
  end?: number;
  score: PerspectiveScore;
}

export interface PerspectiveAttributeScores {
  summaryScore?: PerspectiveScore;
  spanScores?: PerspectiveSpanScore[];
}

export interface AnalyzeCommentResult {
  attributeScores: Record<'TOXICITY', PerspectiveAttributeScores>;
  clientToken?: string;
  detectedLanguages?: string[];
  languages?: string[];
}

export type GooglePerspectiveErrorCategory =
  | 'validation'
  | 'lifecycle'
  | 'timeout'
  | 'transport'
  | 'provider'
  | 'response';
