export interface HealthCheckResponse {
  status: 'ok';
  service: 'mascot-voice-poc';
}

export interface SttResponse {
  transcript: string;
}

export interface AnswerResponse {
  answer: string;
  faqIds: number[];
  matched: boolean;
}

export type ApiErrorCode =
  | 'DEMO_DISABLED'
  | 'METHOD_NOT_ALLOWED'
  | 'INVALID_CONTENT_TYPE'
  | 'INVALID_REQUEST'
  | 'MISSING_AUDIO'
  | 'INVALID_AUDIO'
  | 'AUDIO_TOO_LARGE'
  | 'EMPTY_TRANSCRIPT'
  | 'TEXT_TOO_LONG'
  | 'DATABASE_ERROR'
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
