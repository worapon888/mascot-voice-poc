# Mascot Voice POC

Thai-speaking **2D Mascot AI Voice Chatbot Proof of Concept (POC)** built with Next.js App Router, TypeScript (Strict Mode), Tailwind CSS, Supabase PostgreSQL, and OpenAI Speech/LLM APIs.

---

## 1. Project Purpose

This repository contains the Next.js project setup, Supabase FAQ repository layer, deterministic Thai FAQ retrieval service, Backend Voice Pipeline Route Handlers (`POST /api/stt`, `POST /api/answer`, `POST /api/tts`), G0 & Pipeline smoke-test runners, and automated code-quality tooling (ESLint, Prettier, TypeScript Strict Mode, Husky, and lint-staged) for the Thai-speaking 2D Mascot AI Voice Chatbot POC.

---

## 2. Technology Stack

| Component              | Technology                                                    |
| ---------------------- | ------------------------------------------------------------- |
| Framework              | Next.js 16 (App Router)                                       |
| Language               | TypeScript (Strict Mode)                                      |
| Styling                | Tailwind CSS v4                                               |
| Package Manager        | pnpm                                                          |
| Backend                | Next.js Route Handlers (`nodejs` runtime)                     |
| Database               | Supabase PostgreSQL (`@supabase/supabase-js`)                 |
| STT                    | OpenAI `gpt-transcribe`                                       |
| LLM                    | OpenAI `gpt-4.1-mini` (Responses API)                         |
| TTS                    | OpenAI `gpt-4o-mini-tts` (Voice: `coral`, Format: `mp3`)      |
| Validation             | Zod (`zod`)                                                   |
| Server Boundary Guard  | `server-only`                                                 |
| Git Hooks              | Husky                                                         |
| Staged File Validation | lint-staged                                                   |
| Linter                 | ESLint 9 (Flat Config + Next.js Core Web Vitals & TypeScript) |
| Formatter              | Prettier                                                      |
| Deployment             | Vercel                                                        |

---

## 3. Prerequisites

- **Node.js**: v22 LTS (verified with `v22.19.0`)
- **pnpm**: v9+ / v12+ (verified with `12.15.0`)
- **Git**: v2.30+

---

## 4. Setup Commands

```bash
# 1. Install dependencies
pnpm install

# 2. Copy environment variables template
cp .env.example .env.local

# 3. Execute database schema and seed in Supabase SQL Editor (or via psql)
# - supabase/schema.sql
# - supabase/seed.sql

# 4. Run G0 technical readiness & Voice Pipeline smoke tests
pnpm run smoke:g0
pnpm run smoke:pipeline

# 5. Start local development server
pnpm dev
```

---

## 5. Environment Variables

Configure `.env.local` (never committed to Git) based on `.env.example`:

```env
OPENAI_API_KEY=
SUPABASE_URL=
SUPABASE_SECRET_KEY=
DEMO_ENABLED=true
OPENAI_TIMEOUT_MS=30000
```

### Security & Cost-Control Rules

- `.env.local` is ignored by Git (`.gitignore`).
- Never expose `OPENAI_API_KEY` or `SUPABASE_SECRET_KEY` via `NEXT_PUBLIC_` variables.
- `SUPABASE_SECRET_KEY` must be the server-side Supabase Secret Key (`sb_secret_...` or `service_role` key) so the server-only client can query `public.faqs` with Row Level Security (RLS) enabled and no anonymous policy.
- `DEMO_ENABLED`: Emergency kill-switch for paid API endpoints (`/api/stt`, `/api/answer`, `/api/tts`). Enabled by default in local development unless set to `false`; disabled by default in `NODE_ENV=production` unless explicitly set to `true`.
- `OPENAI_TIMEOUT_MS`: Upstream timeout for OpenAI requests (default `30000` ms, with `maxRetries: 0` to prevent duplicate paid API charges).

---

## 6. Local Development, Code Quality & Smoke-Test Commands

| Command                   | Description                                                             |
| ------------------------- | ----------------------------------------------------------------------- |
| `pnpm dev`                | Start the local Next.js development server                              |
| `pnpm build`              | Build the application for production                                    |
| `pnpm start`              | Start the production server                                             |
| `pnpm lint`               | Run ESLint across the project using ESLint CLI                          |
| `pnpm typecheck`          | Run TypeScript compiler validation (`tsc --noEmit`)                     |
| `pnpm format`             | Format all project files with Prettier                                  |
| `pnpm format:check`       | Check formatting across the project without modifying files             |
| `pnpm check`              | Run `typecheck`, `lint`, and `format:check` sequentially                |
| `pnpm run smoke:g0`       | Run G0 technical readiness smoke tests (Supabase, TTS, STT, LLM)        |
| `pnpm run smoke:pipeline` | Run end-to-end Backend Voice Pipeline HTTP integration & negative tests |
| `pnpm prepare`            | Initialize Husky Git hooks                                              |

---

## 7. API Endpoints

### `GET /api/health`

Returns service readiness (`200 OK`):

```json
{
  "status": "ok",
  "service": "mascot-voice-poc"
}
```

### `POST /api/stt`

- **Content-Type**: `multipart/form-data` (field `audio`, max 3 MB, verified via binary magic bytes: MP3, WAV, WebM, OGG, M4A)
- **Response (`200 OK`)**:

```json
{
  "transcript": "สำนักงานเปิดกี่โมงครับ"
}
```

### `POST /api/answer`

- **Content-Type**: `application/json` (`{ "transcript": "..." }`, 1–500 chars)
- **Response (`200 OK`)**:

```json
{
  "answer": "จุดบริการ Demo เปิดจันทร์–ศุกร์ 09:00–16:00 น. ครับ",
  "faqIds": [1],
  "matched": true
}
```

### `POST /api/tts`

- **Content-Type**: `application/json` (`{ "text": "..." }`, 1–500 chars)
- **Response (`200 OK`)**: Binary MP3 audio (`Content-Type: audio/mpeg`, `Cache-Control: no-store`)

---

## 8. Current Implementation Status

### Completed (Prompt 1, Prompt 2, Prompt 3)

- [x] Next.js App Router initialized with TypeScript Strict Mode, Tailwind CSS, and `@/*` path alias
- [x] ESLint 9, Prettier, Husky (`pre-commit`, `pre-push`), and `lint-staged` configured
- [x] Supabase PostgreSQL schema (`supabase/schema.sql`) with RLS enabled & 5 seeded Thai FAQs (`supabase/seed.sql`)
- [x] Strongly typed server-only FAQ repository (`src/repositories/faq.repository.ts`)
- [x] Deterministic Thai FAQ retrieval service (`src/services/faq-matching.service.ts`)
- [x] Backend Voice Pipeline services (`src/services/transcription.service.ts`, `src/services/answer.service.ts`, `src/services/speech.service.ts`)
- [x] Route Handlers (`POST /api/stt`, `POST /api/answer`, `POST /api/tts`, `GET /api/health`)
- [x] G0 (`pnpm run smoke:g0`) and Voice Pipeline (`pnpm run smoke:pipeline`) smoke-test runners

### Not Yet Implemented (Prompt 4)

- [ ] 2D Mascot UI component (`src/components/mascot/`) with microphone recording (`MediaRecorder`), playback, and audio-reactive mouth-sync states
