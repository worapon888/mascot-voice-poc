export type VoiceState =
  | 'idle'
  | 'listening'
  | 'recording'
  | 'transcribing'
  | 'thinking'
  | 'synthesizing'
  | 'speaking'
  | 'error';

export type VoiceInteractionMode = 'hands-free' | 'push-to-talk';

export type MouthFrame = 'closed' | 'small' | 'open';

export const VOICE_STATE_LABELS: Record<VoiceState, string> = {
  idle: 'พร้อมรับคำถาม',
  listening: 'กำลังฟัง... พูดได้เลย',
  recording: 'กำลังฟังเสียงพูด...',
  transcribing: 'กำลังแปลงเสียงเป็นข้อความ',
  thinking: 'กำลังค้นข้อมูลและสร้างคำตอบ',
  synthesizing: 'กำลังสร้างเสียงตอบกลับ',
  speaking: 'มาสคอตกำลังพูด',
  error: 'เกิดข้อผิดพลาด',
};
