import { VoiceChat } from '@/components/mascot/voice-chat';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-linear-to-b from-[#eef6fb] to-[#e2f0fa] px-4 py-8 text-slate-900 sm:px-6 sm:py-12">
      <VoiceChat />
    </main>
  );
}
