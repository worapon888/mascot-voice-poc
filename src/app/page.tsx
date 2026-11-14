export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-6 py-16 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <div className="w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          Project Setup Ready
        </div>
        <h1 className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
          2D Mascot AI Voice Chatbot POC
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Thai-speaking 2D Mascot AI Voice Chatbot Proof of Concept built with
          Next.js App Router, TypeScript (Strict Mode), Tailwind CSS, Supabase,
          and OpenAI.
        </p>

        <div className="mt-6 rounded-xl bg-zinc-50 p-4 text-sm dark:bg-zinc-800/50">
          <p className="font-medium text-zinc-800 dark:text-zinc-200">
            Health Check Endpoint
          </p>
          <code className="mt-1 block font-mono text-xs text-zinc-600 dark:text-zinc-400">
            GET /api/health
          </code>
        </div>
      </div>
    </main>
  );
}
