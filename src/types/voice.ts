export type VoiceState =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'thinking'
  | 'synthesizing'
  | 'speaking'
  | 'error';

export type MouthFrame = 'closed' | 'small' | 'open';

export const VOICE_STATE_LABELS: Record<VoiceState, string> = {
  idle: 'พร้อมรับฟังคำถาม',
  recording: 'กำลังบันทึกเสียงพูด...',
  transcribing: 'กำลังแปลงเสียงเป็นข้อความ',
  thinking: 'กำลังค้นข้อมูลและสร้างคำตอบ',
  synthesizing: 'กำลังสร้างเสียงตอบกลับ',
  speaking: 'กำลังพูด',
  error: 'เกิดข้อผิดพลาด',
};
