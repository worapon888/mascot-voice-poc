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
