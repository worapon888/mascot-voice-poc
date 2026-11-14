# Mascot Voice POC

Thai-speaking **2D Mascot AI Voice Chatbot Proof of Concept (POC)** built with Next.js App Router, TypeScript (Strict Mode), Tailwind CSS, Supabase PostgreSQL, and OpenAI Speech/LLM APIs.

---

## 1. Project Purpose

This repository contains the foundational Next.js project setup, Supabase FAQ repository layer, G0 technical readiness smoke-test runner, and automated code-quality tooling (ESLint, Prettier, TypeScript Strict Mode, Husky, and lint-staged) for the Thai-speaking 2D Mascot AI Voice Chatbot POC.

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

# 4. Run G0 technical readiness smoke tests
pnpm run smoke:g0

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
```

### Security Rules

- `.env.local` is ignored by Git (`.gitignore`).
- Never expose `OPENAI_API_KEY` or `SUPABASE_SECRET_KEY` via `NEXT_PUBLIC_` variables.
- `SUPABASE_SECRET_KEY` must be the server-side Supabase Secret Key (`sb_secret_...` or `service_role` key) so the server-only client can query `public.faqs` with Row Level Security (RLS) enabled and no anonymous policy.
- External clients (`src/lib/openai/client.ts` and `src/lib/supabase/client.ts`) are guarded with `import 'server-only'` and initialized lazily so the homepage can render even before credentials are provided.

---

## 6. Local Development, Code Quality & G0 Smoke-Test Commands

| Command                           | Description                                                          |
| --------------------------------- | -------------------------------------------------------------------- |
| `pnpm dev`                        | Start the local Next.js development server                           |
| `pnpm build`                      | Build the application for production                                 |
| `pnpm start`                      | Start the production server                                          |
| `pnpm lint`                       | Run ESLint across the project using ESLint CLI                       |
| `pnpm typecheck`                  | Run TypeScript compiler validation (`tsc --noEmit`)                  |
| `pnpm format`                     | Format all project files with Prettier                               |
| `pnpm format:check`               | Check formatting across the project without modifying files          |
| `pnpm check`                      | Run `typecheck`, `lint`, and `format:check` sequentially             |
| `pnpm run smoke:g0`               | Run all G0 technical readiness smoke tests (Supabase, TTS, STT, LLM) |
| `pnpm run smoke:g0 -- --only=db`  | Run only Supabase database smoke tests (`DB01`–`DB05`)               |
| `pnpm run smoke:g0 -- --only=stt` | Run only OpenAI `gpt-transcribe` STT smoke test                      |
| `pnpm run smoke:g0 -- --only=llm` | Run only OpenAI `gpt-4.1-mini` LLM & grounded FAQ smoke tests        |
| `pnpm run smoke:g0 -- --only=tts` | Run only OpenAI `gpt-4o-mini-tts` (`coral`) TTS smoke test           |
| `pnpm prepare`                    | Initialize Husky Git hooks                                           |

---

## 7. Git Hooks (Husky & lint-staged)

### Pre-commit Hook (`.husky/pre-commit`)

Runs `pnpm exec lint-staged` on staged files only:

- `*.{js,jsx,ts,tsx}`:
  1. `eslint --fix` (applies safe automatic fixes; aborts commit on unfixed lint errors)
  2. `prettier --write`
- `*.{json,md,css,yml,yaml}`:
  1. `prettier --write`

### Pre-push Hook (`.husky/pre-push`)

Runs full repository verification before allowing a `git push`:

1. `pnpm run typecheck` (`tsc --noEmit`)
2. `pnpm run lint` (`eslint`)

---

## 8. Health-Check Endpoint

### `GET /api/health`

Verifies that the Next.js Node.js Route Handler runtime is up and responding.

- **URL**: `http://localhost:3000/api/health`
- **Method**: `GET`
- **Response (`200 OK`)**:

```json
{
  "status": "ok",
  "service": "mascot-voice-poc"
}
```

---

## 9. Current Implementation Status

### Completed (Prompt 1 & Prompt 2 — Setup & G0 Readiness)

- [x] Next.js App Router initialized with TypeScript Strict Mode, Tailwind CSS, and `@/*` path alias
- [x] ESLint 9, Prettier, Husky (`pre-commit`, `pre-push`), and `lint-staged` configured
- [x] Server-only lazy client factories for OpenAI and Supabase (`src/lib/openai/client.ts`, `src/lib/supabase/client.ts`)
- [x] Working `GET /api/health` endpoint
- [x] Supabase PostgreSQL schema (`supabase/schema.sql`) with RLS enabled on `public.faqs`
- [x] Five Thai demonstration FAQ records with keyword aliases (`supabase/seed.sql`)
- [x] Strongly typed server-only FAQ repository (`src/repositories/faq.repository.ts`, `src/types/faq.ts`)
- [x] Developer-only G0 smoke-test runner (`src/scripts/g0-smoke.ts` via `pnpm run smoke:g0`)

### Not Yet Implemented (Subsequent Tasks)

- [ ] Thai FAQ keyword matching and question-answering service (`src/services/`)
- [ ] Speech-to-Text Route Handler (`POST /api/stt`)
- [ ] Grounded Question-Answering Route Handler (`POST /api/answer`)
- [ ] Text-to-Speech Route Handler (`POST /api/tts`)
- [ ] 2D Mascot UI component (`src/components/mascot/`) with audio recording, playback, and mouth-sync states
