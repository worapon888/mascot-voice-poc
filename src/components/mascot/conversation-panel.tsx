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
}

const DEMO_SAMPLE_QUESTIONS = [
  'เปิดบริการกี่โมง',
  'ต้องจองคิวไหม',
  'เตรียมเอกสารอะไร',
  'ทดลองผ่านมือถือได้ไหม',
  'ติดต่อใครเมื่อไม่มีคำตอบ',
] as const;

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
}: ConversationPanelProps) {
  const modePresentation = getAnswerModePresentation(
    matched,
    answerMode,
    matchedFaqIds,
  );

  return (
    <div className="flex w-full flex-col gap-4">
      {/* Error Banner */}
      {errorMessage && (
        <div
          role="alert"
          data-testid="error-banner"
          className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 shadow-xs"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold text-amber-900">แจ้งเตือนจากระบบสาธิต</p>
              <p className="mt-1 text-amber-800">{errorMessage}</p>
            </div>
            {canRetry && (
              <button
                type="button"
                data-testid="retry-btn"
                onClick={onRetry}
                className="shrink-0 rounded-full bg-amber-700 px-4 py-2 text-xs font-semibold text-white transition hover:bg-amber-800"
              >
                ลองส่งใหม่อีกครั้ง
              </button>
            )}
          </div>
        </div>
      )}

      {/* Recognized Transcript Box */}
      <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
        <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
          ข้อความที่รับฟังได้ (Transcript)
        </p>
        <p
          data-testid="transcript-text"
          className="mt-1.5 min-h-[1.75rem] text-base font-medium text-slate-900"
        >
          {transcript || (
            <span className="font-normal text-slate-400">
              กดปุ่ม &ldquo;กดเพื่อพูดคำถาม&rdquo; แล้วพูดคำถามภาษาไทยของคุณ...
            </span>
          )}
        </p>
      </div>

      {/* AI Answer Box */}
      <div className="rounded-2xl border border-sky-200 bg-sky-50/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold tracking-wide text-sky-800 uppercase">
            คำตอบจากมาสคอต AI (Answer)
          </p>
          {modePresentation && (
            <span
              data-testid="faq-match-badge"
              data-answer-mode={
                answerMode ??
                (matched ? 'FAQ_GROUNDED' : 'ORGANIZATION_INFO_UNKNOWN')
              }
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${modePresentation.className}`}
            >
              {modePresentation.label}
            </span>
          )}
        </div>
        <p
          data-testid="answer-text"
          className="mt-1.5 min-h-[2.25rem] text-base leading-relaxed font-medium text-slate-900"
        >
          {answer || (
            <span className="font-normal text-slate-400">
              คำตอบและเสียงพูดภาษาไทยจะแสดงที่นี่หลังส่งคำถาม...
            </span>
          )}
        </p>
      </div>

      {/* Demo Questions Hint */}
      <div className="rounded-2xl border border-slate-200/80 bg-white p-4">
        <p className="text-xs font-semibold text-slate-600">
          คำถามตัวอย่างในฐานข้อมูลสาธิต (พูดถามผ่านไมโครโฟนได้ทันที):
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {DEMO_SAMPLE_QUESTIONS.map((q) => (
            <span
              key={q}
              className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-700"
            >
              &ldquo;{q}&rdquo;
            </span>
          ))}
        </div>
      </div>

      {/* Mandatory Notices */}
      <div className="border-t border-slate-200 pt-3 text-center text-xs leading-relaxed text-slate-500">
        <p className="font-medium text-slate-600">เสียงตอบกลับสร้างโดย AI</p>
        <p className="mt-0.5">
          ข้อมูลคำถาม–คำตอบ (FAQ) ในระบบนี้เป็นข้อมูลสมมติสำหรับการสาธิต (Demo) เท่านั้น
          ไม่ใช่ข้อมูลทางการขององค์กร (แนะนำใช้งานบน Google Chrome Desktop)
        </p>
      </div>
    </div>
  );
}
