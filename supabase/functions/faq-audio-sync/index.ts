// =============================================================================
// Supabase Edge Function: faq-audio-sync
// Runtime: Deno (Supabase Edge Functions)
// Purpose:
//   Receives Supabase Database Webhook events (INSERT / UPDATE on `public.faqs`)
//   and ensures persistent content-addressed MP3 audio is generated via OpenAI
//   `gpt-4o-mini-tts` and stored in Supabase Storage (`mascot-faq-audio`).
//
// Supported Modes:
//   - Mode A (Proxy Mode): If `APP_WEBHOOK_URL` is configured, forwards the
//     authenticated webhook payload to Next.js `POST /api/faq-audio/webhook`
//     (guaranteeing 100% shared Node.js Thai speech normalizer & single-flight state).
//   - Mode B (Standalone Edge Mode): Directly normalizes Thai clock expressions,
//     computes the SHA-256 content hash, checks `public.faq_audio_assets`,
//     invokes OpenAI `gpt-4o-mini-tts`, uploads the MP3 to Supabase Storage,
//     re-verifies the latest FAQ version in PostgreSQL, and commits status='READY'.
// =============================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_VOICE = 'coral';
const NORMALIZER_VERSION = 'v1';
const DEFAULT_BUCKET = 'mascot-faq-audio';
const THAI_TTS_INSTRUCTIONS =
  'พูดภาษาไทยให้ชัดเจน เป็นธรรมชาติ ใช้น้ำเสียงสุภาพและเป็นมิตร อ่านเวลาตามการพูดภาษาไทยทั่วไป เว้นจังหวะอย่างเหมาะสม ไม่อ่านเครื่องหมายวรรคตอนหรือตัวย่อเป็นคำแปลก ๆ';

const TRAILING_POLITE_REGEX = /(ครับผม|นะครับ|นะคะ|ครับ|ค่ะ|คะ)$/u;

function buildCanonicalFaqAnswer(raw: string): string {
  const trimmed = raw.normalize('NFC').trim();
  if (!trimmed) return '';
  if (TRAILING_POLITE_REGEX.test(trimmed)) return trimmed.slice(0, 500).trim();
  return `${trimmed} ครับ`.slice(0, 500).trim();
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED' } }),
      { status: 405, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const webhookSecret = Deno.env.get('FAQ_AUDIO_WEBHOOK_SECRET')?.trim() ?? '';
  const incomingSecret =
    req.headers.get('x-webhook-secret')?.trim() ||
    req.headers
      .get('authorization')
      ?.replace(/^Bearer\s+/i, '')
      .trim() ||
    '';

  if (
    !webhookSecret ||
    webhookSecret.length < 16 ||
    incomingSecret !== webhookSecret
  ) {
    return new Response(
      JSON.stringify({
        error: { code: 'UNAUTHORIZED', message: 'Invalid webhook secret' },
      }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const rawBodyText = await req.text();
  const appWebhookUrl = Deno.env.get('APP_WEBHOOK_URL')?.trim();

  // Mode A: Forward to Next.js POST /api/faq-audio/webhook if configured
  if (appWebhookUrl) {
    const proxyRes = await fetch(appWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': webhookSecret,
      },
      body: rawBodyText,
    });
    const proxyText = await proxyRes.text();
    return new Response(proxyText, {
      status: proxyRes.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Mode B: Standalone Edge execution
  const payload = JSON.parse(rawBodyText);
  const record = payload?.record;
  if (!record || !record.is_active || typeof record.id !== 'number') {
    return new Response(
      JSON.stringify({ processed: false, reason: 'FAQ_INACTIVE_OR_MISSING' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const canonicalAnswer = buildCanonicalFaqAnswer(String(record.answer ?? ''));
  const hashPayload = JSON.stringify({
    v: NORMALIZER_VERSION,
    model: TTS_MODEL,
    voice: TTS_VOICE,
    instructions: THAI_TTS_INSTRUCTIONS,
    normalizedInput: canonicalAnswer,
  });
  const contentHash = await sha256Hex(hashPayload);
  const bucketName =
    Deno.env.get('SUPABASE_FAQ_AUDIO_BUCKET')?.trim() || DEFAULT_BUCKET;
  const objectPath = `faqs/${NORMALIZER_VERSION}/faq-${record.id}-${contentHash}.mp3`;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const openAiKey = Deno.env.get('OPENAI_API_KEY')!;

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Check if already READY
  const { data: existing } = await supabase
    .from('faq_audio_assets')
    .select('status, byte_length')
    .eq('faq_id', record.id)
    .eq('content_hash', contentHash)
    .maybeSingle();

  if (existing?.status === 'READY' && existing?.byte_length > 0) {
    return new Response(
      JSON.stringify({
        processed: true,
        outcome: 'ALREADY_READY',
        faqId: record.id,
        contentHash,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Generate MP3 via OpenAI TTS
  const ttsResponse = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openAiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: canonicalAnswer,
      instructions: THAI_TTS_INSTRUCTIONS,
      response_format: 'mp3',
    }),
  });

  if (!ttsResponse.ok) {
    return new Response(
      JSON.stringify({
        processed: true,
        outcome: 'FAILED',
        error: `OpenAI TTS HTTP ${ttsResponse.status}`,
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const mp3Bytes = new Uint8Array(await ttsResponse.arrayBuffer());

  await supabase.storage.from(bucketName).upload(objectPath, mp3Bytes, {
    contentType: 'audio/mpeg',
    cacheControl: '31536000',
    upsert: true,
  });

  // Re-verify latest FAQ row before marking READY
  const { data: latestFaq } = await supabase
    .from('faqs')
    .select('id, answer, is_active')
    .eq('id', record.id)
    .maybeSingle();

  if (
    !latestFaq ||
    !latestFaq.is_active ||
    buildCanonicalFaqAnswer(latestFaq.answer) !== canonicalAnswer
  ) {
    return new Response(
      JSON.stringify({
        processed: true,
        outcome: 'SUPERSEDED_BY_NEWER_VERSION',
        faqId: record.id,
        contentHash,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const nowIso = new Date().toISOString();
  await supabase.from('faq_audio_assets').upsert(
    {
      faq_id: record.id,
      content_hash: contentHash,
      canonical_answer: canonicalAnswer,
      normalized_speech_text: canonicalAnswer,
      bucket_name: bucketName,
      object_path: objectPath,
      mime_type: 'audio/mpeg',
      byte_length: mp3Bytes.byteLength,
      tts_model: TTS_MODEL,
      tts_voice: TTS_VOICE,
      normalizer_version: NORMALIZER_VERSION,
      status: 'READY',
      attempt_count: 1,
      last_error: null,
      generated_at: nowIso,
      updated_at: nowIso,
    },
    { onConflict: 'faq_id,content_hash' },
  );

  return new Response(
    JSON.stringify({
      processed: true,
      outcome: 'GENERATED_AND_READY',
      faqId: record.id,
      contentHash,
      objectPath,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
});
