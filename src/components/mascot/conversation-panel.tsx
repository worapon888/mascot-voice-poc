'use client';

import type { AnswerMode } from '@/types/api';

interface ConversationPanelProps {
  transcript: string;
  answer: string;
  matchedFaqIds: number[];
  matched: boolean | null;
  answerMode?: AnswerMode | null;
  errorMessage: string | null;
  canRetry: boolean;
  onRetry: () => void;
  expanded?: boolean;
  diagnostics?: {
    source: string;
    mimeType: string;
    byteSize: number;
    durationSeconds: number;
    audioUrl?: string;
    timings?: {
      speechEndToVadCommitMs?: number;
      vadCommitToSttMs?: number;
      sttToAnswerMs?: number;
      answerToAudioReadyMs?: number;
      audioReadyToPlaybackMs?: number;
      totalSpeechEndToPlaybackMs?: number;
    };
  } | null;
}

function getAnswerModePresentation(
  matched: boolean | null,
  answerMode: AnswerMode | null | undefined,
  matchedFaqIds: number[],
): { label: string; className: string } | null {
  if (matched === null && !answerMode) {
    return null;
  }

  const effectiveMode: AnswerMode =
    answerMode ?? (matched ? 'FAQ_GROUNDED' : 'ORGANIZATION_INFO_UNKNOWN');

  if (effectiveMode === 'FAQ_GROUNDED') {
    const idSuffix =
      matchedFaqIds.length > 0 ? ` (#${matchedFaqIds.join(', #')})` : '';
    return {
      label: `อ้างอิงข้อมูล FAQ${idSuffix}`,
      className: 'bg-emerald-100 text-emerald-800',
    };
  }

  if (effectiveMode === 'GENERAL_GUIDANCE') {
    return {
      label: 'คำแนะนำทั่วไปจาก AI',
      className: 'bg-sky-100 text-sky-800',
    };
  }

  return {
    label: 'ยังไม่มีข้อมูลเฉพาะหน่วยงาน',
    className: 'bg-amber-100 text-amber-900',
  };
}

export function ConversationPanel({
  transcript,
  answer,
  matchedFaqIds,
  matched,
  answerMode,
  errorMessage,
  canRetry,
  onRetry,
  expanded = false,
  diagnostics,
}: ConversationPanelProps) {
  const modePresentation = getAnswerModePresentation(
    matched,
    answerMode,
    matchedFaqIds,
  );

  const hasVisibleContent = Boolean(
    errorMessage || transcript || answer || expanded,
  );

  return (
    <div className="flex w-full flex-col items-center">
      {/* Error Banner */}
      {errorMessage && (
        <div
          role="alert"
          data-testid="error-banner"
          className="mb-3 w-full rounded-xl border border-amber-300 bg-amber-50/95 p-3 text-xs text-amber-950 shadow-xs"
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold text-amber-900">แจ้งเตือนจากระบบ</p>
              <p className="mt-0.5 text-amber-800">{errorMessage}</p>
            </div>
            {canRetry && (
              <button
                type="button"
                data-testid="retry-btn"
                onClick={onRetry}
                className="shrink-0 rounded-full bg-amber-700 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-800"
              >
                ลองส่งใหม่อีกครั้ง
              </button>
            )}
          </div>
        </div>
      )}

      {/* Live Conversation Result Box (shown when speaking/answered or toggled via info icon) */}
      <div
        className={
          hasVisibleContent ? 'mb-3 flex w-full flex-col gap-2' : 'sr-only'
        }
      >
        {/* Recognized Transcript */}
        <div className="rounded-xl border border-[#dce4ec] bg-white/90 px-3.5 py-2.5 shadow-2xs">
          <p className="text-[11px] font-semibold text-slate-500">คำถามของคุณ</p>
          <p
            data-testid="transcript-text"
            className="mt-0.5 text-sm font-medium text-[#102a45]"
          >
            {transcript || 'ยังไม่มีข้อความเสียงที่บันทึก'}
          </p>
        </div>

        {/* AI Grounded Answer */}
        <div className="rounded-xl border border-[#cbe2f6] bg-[#f0f8ff]/90 px-3.5 py-2.5 shadow-2xs">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <p className="text-[11px] font-semibold text-[#15426e]">
              คำตอบจากผู้ช่วยประชาสัมพันธ์
            </p>
            {modePresentation && (
              <span
                data-testid="faq-match-badge"
                data-answer-mode={
                  answerMode ??
                  (matched ? 'FAQ_GROUNDED' : 'ORGANIZATION_INFO_UNKNOWN')
                }
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${modePresentation.className}`}
              >
                {modePresentation.label}
              </span>
            )}
          </div>
          <p
            data-testid="answer-text"
            className="mt-0.5 text-sm leading-relaxed font-medium text-[#102a45]"
          >
            {answer || 'คำตอบและเสียงพูดภาษาไทยจะแสดงที่นี่หลังส่งคำถาม'}
          </p>
        </div>

        {/* Development Audio Diagnostics Box */}
        {expanded && diagnostics && (
          <div
            data-testid="audio-diagnostics-card"
            className="rounded-xl border border-indigo-200 bg-indigo-50/90 px-3.5 py-2.5 text-xs text-indigo-950 shadow-2xs"
          >
            <div className="flex items-center justify-between">
              <p className="font-semibold text-indigo-900">
                🔍 Audio Payload Diagnostics
              </p>
              <span className="rounded-full bg-indigo-200/80 px-2 py-0.5 text-[10px] font-medium text-indigo-900">
                {diagnostics.source}
              </span>
            </div>
            <div className="mt-1.5 grid grid-cols-1 gap-1 text-[11px] text-indigo-800 sm:grid-cols-3">
              <div>
                <span className="text-indigo-600">Format:</span>{' '}
                <code className="font-mono">{diagnostics.mimeType}</code>
              </div>
              <div>
                <span className="text-indigo-600">Size:</span>{' '}
                <span className="font-mono">
                  {(diagnostics.byteSize / 1024).toFixed(1)} KB (
                  {diagnostics.byteSize} B)
                </span>
              </div>
              <div>
                <span className="text-indigo-600">Duration:</span>{' '}
                <span className="font-mono">
                  ~{diagnostics.durationSeconds}s
                </span>
              </div>
            </div>
            {diagnostics.audioUrl && (
              <div className="mt-2 flex flex-col gap-1 border-t border-indigo-200/60 pt-2 sm:flex-row sm:items-center sm:gap-3">
                <span className="shrink-0 text-[11px] font-medium text-indigo-700">
                  🔊 ฟังเสียงที่บันทึกล่าสุด:
                </span>
                <audio
                  controls
                  src={diagnostics.audioUrl}
                  className="h-7 w-full max-w-[260px]"
                />
              </div>
            )}
            {diagnostics.timings && (
              <div className="mt-2 border-t border-indigo-200/60 pt-2 text-[11px] text-indigo-900">
                <span className="font-semibold text-indigo-700">
                  ⚡ Timing Breakdown:
                </span>
                <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
                  {diagnostics.timings.speechEndToVadCommitMs !== undefined && (
                    <div>
                      VAD Commit:{' '}
                      <span className="font-mono font-semibold">
                        {diagnostics.timings.speechEndToVadCommitMs}ms
                      </span>
                    </div>
                  )}
                  {diagnostics.timings.vadCommitToSttMs !== undefined && (
                    <div>
                      STT:{' '}
                      <span className="font-mono font-semibold">
                        {diagnostics.timings.vadCommitToSttMs}ms
                      </span>
                    </div>
                  )}
                  {diagnostics.timings.sttToAnswerMs !== undefined && (
                    <div>
                      Answer:{' '}
                      <span className="font-mono font-semibold">
                        {diagnostics.timings.sttToAnswerMs}ms
                      </span>
                    </div>
                  )}
                  {diagnostics.timings.answerToAudioReadyMs !== undefined && (
                    <div>
                      Audio Ready:{' '}
                      <span className="font-mono font-semibold">
                        {diagnostics.timings.answerToAudioReadyMs}ms
                      </span>
                    </div>
                  )}
                  {diagnostics.timings.audioReadyToPlaybackMs !== undefined && (
                    <div>
                      Playback Start:{' '}
                      <span className="font-mono font-semibold">
                        {diagnostics.timings.audioReadyToPlaybackMs}ms
                      </span>
                    </div>
                  )}
                  {diagnostics.timings.totalSpeechEndToPlaybackMs !==
                    undefined && (
                    <div className="col-span-2 font-bold text-emerald-800 sm:col-span-1">
                      Total E2E:{' '}
                      <span className="font-mono">
                        {(
                          diagnostics.timings.totalSpeechEndToPlaybackMs / 1000
                        ).toFixed(2)}
                        s
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Sample Questions Line matching the reference screenshot */}
      <div className="mt-0.5 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-center text-xs font-medium tracking-tight text-[#1e3348] sm:text-sm">
        <span>ตัวอย่างคำถาม: เวลาทำการ</span>
        <span aria-hidden="true" className="text-[#697d92]">
          |
        </span>
        <span>บริการประชาชน</span>
        <span aria-hidden="true" className="text-[#697d92]">
          |
        </span>
        <span>ติดต่อหน่วยงาน</span>
      </div>
    </div>
  );
}
