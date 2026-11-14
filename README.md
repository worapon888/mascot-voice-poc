# Mascot Voice POC

Thai-speaking **2D Mascot AI Voice Chatbot Proof of Concept (POC)** built with Next.js App Router, TypeScript (Strict Mode), Tailwind CSS, Supabase PostgreSQL, and OpenAI Speech/LLM APIs.

---

## 1. Project Purpose

This repository contains the complete 2D Mascot AI Voice Chatbot POC:

- Original 2D Mascot UI (`MascotAvatar`, `VoiceChat`, `MicrophoneButton`, `ConversationPanel`)
- Browser-native microphone recording (`MediaRecorder`) and Web Audio API real-time amplitude-driven mouth lip-sync (`AnalyserNode` + `requestAnimationFrame`)
- Backend Voice Pipeline Route Handlers (`POST /api/stt`, `POST /api/answer`, `POST /api/tts`, `GET /api/health`)
- Deterministic Thai FAQ retrieval service grounded on Supabase PostgreSQL (`public.faqs`)
- Automated code-quality tooling (ESLint, Prettier, TypeScript Strict Mode, Husky, and lint-staged)

---

## 2. Technology Stack

| Component                 | Technology                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| Framework                 | Next.js 16 (App Router)                                                                           |
| Language                  | TypeScript (Strict Mode)                                                                          |
| Styling                   | Tailwind CSS v4                                                                                   |
| Package Manager           | pnpm                                                                                              |
| Frontend Audio & Lip-Sync | Browser `MediaRecorder` + Web Audio API (`AudioContext`, `AnalyserNode`, `requestAnimationFrame`) |
| Backend                   | Next.js Route Handlers (`nodejs` runtime)                                                         |
| Database                  | Supabase PostgreSQL (`@supabase/supabase-js`)                                                     |
| STT                       | OpenAI `gpt-transcribe`                                                                           |
| LLM                       | OpenAI `gpt-4.1-mini` (Responses API)                                                             |
| TTS                       | OpenAI `gpt-4o-mini-tts` (Voice: `coral`, Format: `mp3`)                                          |
| Validation                | Zod (`zod`)                                                                                       |
| Server Boundary Guard     | `server-only`                                                                                     |
| Git Hooks                 | Husky + `lint-staged`                                                                             |
| Linter & Formatter        | ESLint 9 + Prettier                                                                               |
| Deployment                | Vercel                                                                                            |

---

## 3. Prerequisites

- **Node.js**: v22 LTS (verified with `v22.19.0`)
- **pnpm**: v9+ / v12+ (verified with `12.15.0`)
- **Browser**: Google Chrome Desktop (recommended for microphone & Web Audio API)

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

- **`GET /api/health`** — Returns `{ "status": "ok", "service": "mascot-voice-poc" }`
- **`POST /api/stt`** — `multipart/form-data` (`audio`, max 3 MB) → `{ "transcript": "..." }`
- **`POST /api/answer`** — `application/json` (`{ "transcript": "..." }`) → `{ "answer": "...", "faqIds": [1], "matched": true }`
- **`POST /api/tts`** — `application/json` (`{ "text": "..." }`) → Binary `audio/mpeg` (`Cache-Control: no-store`)

---

## 8. Current Implementation Status

- [x] **Prompt 1**: Project Setup, TypeScript Strict Mode, ESLint, Prettier, Husky, `lint-staged`
- [x] **Prompt 2**: Supabase PostgreSQL Schema & 5 Demo FAQs, Repository, G0 Smoke Tests (`9/9 PASSED`)
- [x] **Prompt 3**: Backend Voice Pipeline (`/api/stt`, `/api/answer`, `/api/tts`) & HTTP Integration Tests (`7/7 PASSED`)
- [x] **Prompt 4**: Original 2D Mascot Assets imported (`public/assets/mascot/`), Voice Interaction State Machine, `MediaRecorder` hook, Web Audio API RMS Lip-Sync hook, and Thai Frontend UI
