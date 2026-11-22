export interface HealthCheckResponse {
  status: 'ok';
  service: 'mascot-voice-poc';
}

export interface SttResponse {
  transcript: string;
}

export type AnswerMode =
  'FAQ_GROUNDED' | 'GENERAL_GUIDANCE' | 'ORGANIZATION_INFO_UNKNOWN';

export type ResponseTier = 'TIER_1' | 'TIER_2' | 'TIER_3';

export type ConversationTurnRole = 'user' | 'assistant';

export interface ConversationTurn {
  role: ConversationTurnRole;
  text: string;
  faqIds?: number[];
}

export interface AnswerAudioRef {
  faqId: number;
  contentHash: string;
  audioUrl: string;
  objectPath: string;
  mimeType: 'audio/mpeg';
  byteLength: number;
}

export interface AnswerResponse {
  answer: string;
  faqIds: number[];
  matched: boolean;
  answerMode?: AnswerMode;
  tier?: ResponseTier;
  audioRef?: AnswerAudioRef;
}

export type FaqWebhookEventType = 'INSERT' | 'UPDATE' | 'DELETE';

export interface SupabaseFaqWebhookPayload {
  type: FaqWebhookEventType;
  table: string;
  schema: string;
  record: {
    id: number;
    question: string;
    answer: string;
    keywords?: string[];
    is_active: boolean;
    created_at?: string;
  } | null;
  old_record: {
    id: number;
    question: string;
    answer: string;
    keywords?: string[];
    is_active: boolean;
    created_at?: string;
  } | null;
}

export type ApiErrorCode =
  | 'DEMO_DISABLED'
  | 'METHOD_NOT_ALLOWED'
  | 'UNAUTHORIZED'
  | 'INVALID_CONTENT_TYPE'
  | 'INVALID_REQUEST'
  | 'MISSING_AUDIO'
  | 'INVALID_AUDIO'
  | 'AUDIO_TOO_LARGE'
  | 'EMPTY_TRANSCRIPT'
  | 'TEXT_TOO_LONG'
  | 'DATABASE_ERROR'
  | 'STORAGE_ERROR'
  | 'RATE_LIMITED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_PROVIDER_ERROR'
  | 'INTERNAL_ERROR';

export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}
