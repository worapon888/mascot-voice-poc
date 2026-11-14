# Mascot Voice POC

Thai-speaking **2D Mascot AI Voice Chatbot Proof of Concept (POC)** built with Next.js App Router, TypeScript (Strict Mode), Tailwind CSS, Supabase PostgreSQL, and OpenAI Speech/LLM APIs.

---

## 1. Project Purpose

This repository contains the foundational Next.js project setup, modular architecture boundaries, and automated code-quality tooling (ESLint, Prettier, TypeScript Strict Mode, Husky, and lint-staged) for the Thai-speaking 2D Mascot AI Voice Chatbot POC.

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
| LLM                    | OpenAI `gpt-4.1-mini`                                         |
| TTS                    | OpenAI `gpt-4o-mini-tts`                                      |
| Validation             | Zod (`zod`)                                                   |
| Server Boundary Guard  | `server-only`                                                 |
| Git Hooks              | Husky                                                         |
| Staged File Validation | lint-staged                                                   |
| Linter                 | ESLint 9 (Flat Config + Next.js Core Web Vitals & TypeScript) |
| Formatter              | Prettier                                                      |
| Deployment             | Vercel                                                        |

---

## 3. Prerequisites

- **Node.js**: v20.9+ or v22 LTS (verified with `v22.19.0`)
- **pnpm**: v9+ / v12+ (verified with `12.15.0`)
- **Git**: v2.30+

---

## 4. Setup Commands

```bash
# 1. Install dependencies
pnpm install

# 2. Copy environment variables template
cp .env.example .env.local

# 3. Start local development server
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
- External clients (`src/lib/openai/client.ts` and `src/lib/supabase/client.ts`) are guarded with `import 'server-only'` and initialized lazily so the homepage can render even before credentials are provided.

---

## 6. Local Development & Code Quality Commands

| Command             | Description                                                 |
| ------------------- | ----------------------------------------------------------- |
| `pnpm dev`          | Start the local Next.js development server                  |
| `pnpm build`        | Build the application for production                        |
| `pnpm start`        | Start the production server                                 |
| `pnpm lint`         | Run ESLint across the project using ESLint CLI              |
| `pnpm typecheck`    | Run TypeScript compiler validation (`tsc --noEmit`)         |
| `pnpm format`       | Format all project files with Prettier                      |
| `pnpm format:check` | Check formatting across the project without modifying files |
| `pnpm check`        | Run `typecheck`, `lint`, and `format:check` sequentially    |
| `pnpm prepare`      | Initialize Husky Git hooks                                  |

---

## 7. Git Hooks (Husky & lint-staged)

### Pre-commit Hook (`.husky/pre-commit`)

Runs `pnpm exec lint-staged` on staged files only:

- `*.{js,jsx,ts,tsx}`:
  1. `eslint --fix` (applies safe automatic fixes; aborts commit on unfixed lint errors)
  2. `prettier --write`
- `*.{json,md,css,yml,yaml}`:
  1. `prettier --write`

Does **not** run a full production build on pre-commit to keep commits fast.

### Pre-push Hook (`.husky/pre-push`)

Runs full repository verification before allowing a `git push`:

1. `pnpm run typecheck` (`tsc --noEmit`)
2. `pnpm run lint` (`eslint`)

If either check fails, the push is blocked with a non-zero exit status.

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

_(Note: This endpoint intentionally does not expose secrets or claim external OpenAI/Supabase connectivity.)_

---

## 9. Current Implementation Status

### Completed (Project Bootstrap & Tooling)

- [x] Next.js App Router initialized with TypeScript Strict Mode, Tailwind CSS, and `@/*` path alias
- [x] Runtime (`openai`, `@supabase/supabase-js`, `zod`, `server-only`) and development (`husky`, `lint-staged`, `prettier`, `eslint`) dependencies installed
- [x] ESLint CLI flat configuration (`eslint.config.mjs`) with Next.js Core Web Vitals, React Hooks, and TypeScript rules
- [x] Prettier configuration (`.prettierrc.json`, `.prettierignore`) compatible with ESLint
- [x] Husky `pre-commit` (`lint-staged`) and `pre-push` (`typecheck` + `lint`) hooks configured
- [x] Modular project folder structure (`src/app/api/{health,stt,answer,tts}`, `src/components/mascot`, `src/lib/{openai,supabase,validations}`, `src/services`, `src/repositories`, `src/types`, `supabase/`)
- [x] Server-only lazy client factories for OpenAI and Supabase
- [x] Working `GET /api/health` endpoint

### Not Yet Implemented (Future Tasks)

- [ ] Supabase schema definition (`supabase/schema.sql`) and Thai knowledge base seed (`supabase/seed.sql`)
- [ ] Repository layer (`src/repositories/`) for knowledge retrieval from Supabase PostgreSQL
- [ ] Speech-to-Text service & route (`POST /api/stt` using `gpt-transcribe`)
- [ ] Question-Answering service & route (`POST /api/answer` using `gpt-4.1-mini` grounded on Supabase data)
- [ ] Text-to-Speech service & route (`POST /api/tts` using `gpt-4o-mini-tts`)
- [ ] 2D Mascot UI component (`src/components/mascot/`) with audio recording, playback, and mouth-sync states

---

## 10. Next Development Steps

1. Define the Supabase PostgreSQL table schema in `supabase/schema.sql` and seed data in `supabase/seed.sql`.
2. Implement the Supabase knowledge repository in `src/repositories/` and QA service in `src/services/`.
3. Implement the `POST /api/stt`, `POST /api/answer`, and `POST /api/tts` Route Handlers with Zod request validation.
4. Build the 2D Mascot interactive voice UI in `src/components/mascot/` and connect it to the backend pipeline.
