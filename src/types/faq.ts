export interface FaqRecord {
  id: number;
  question: string;
  answer: string;
  keywords: string[];
  is_active: boolean;
  created_at: string;
}

export type FaqAudioStatus = 'PENDING' | 'GENERATING' | 'READY' | 'FAILED';

export interface FaqAudioAssetRecord {
  faq_id: number;
  content_hash: string;
  canonical_answer: string;
  normalized_speech_text: string;
  bucket_name: string;
  object_path: string;
  mime_type: string;
  byte_length: number;
  tts_model: string;
  tts_voice: string;
  normalizer_version: string;
  status: FaqAudioStatus;
  attempt_count: number;
  last_error: string | null;
  generated_at: string | null;
  updated_at: string;
}

export interface PersistentFaqAudioReference {
  faqId: number;
  contentHash: string;
  audioUrl: string;
  objectPath: string;
  mimeType: 'audio/mpeg';
  byteLength: number;
}
