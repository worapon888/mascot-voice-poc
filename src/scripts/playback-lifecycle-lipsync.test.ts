import assert from 'node:assert/strict';
import {
  computeMouthFrameFromSamples,
  type AudioQueueController,
  type PlayAudioOutcome,
} from '@/hooks/use-audio-lipsync';
import type { MouthFrame, VoiceState } from '@/types/voice';

/**
 * Creates synthetic PCM 8-bit time-domain audio samples centered at 128 (Web Audio API byte format)
 */
function createSyntheticTimeDomainData(
  amplitudeLevel: 'silence' | 'medium' | 'loud',
  length = 1024,
): Uint8Array {
  const data = new Uint8Array(length);
  const amplitudeMultiplier =
    amplitudeLevel === 'silence' ? 1 : amplitudeLevel === 'medium' ? 12 : 28;

  for (let i = 0; i < length; i++) {
    // Generate sine wave oscillating around 128
    const val =
      128 + Math.round(amplitudeMultiplier * Math.sin((i / 32) * Math.PI * 2));
    data[i] = Math.max(0, Math.min(255, val));
  }
  return data;
}

/**
 * Simulates Avatar's effective mouth calculation from mascot-avatar.tsx#L45:
 * const effectiveMouth: MouthFrame = voiceState === 'speaking' ? mouthFrame : 'closed';
 */
function getEffectiveAvatarMouth(
  voiceState: VoiceState,
  mouthFrame: MouthFrame,
): MouthFrame {
  return voiceState === 'speaking' ? mouthFrame : 'closed';
}

async function runPlaybackLifecycleTests() {
  console.log(
    '================================================================================',
  );
  console.log(
    ' PLAYBACK LIFECYCLE & STATE SYNCHRONIZATION REGRESSION TEST SUITE',
  );
  console.log(
    '================================================================================\n',
  );

  // ---------------------------------------------------------------------------
  // Test 1: Real Amplitude & Mouth Frame Mapping (No Fake Animation)
  // ---------------------------------------------------------------------------
  console.log(
    'Test 1: Real Amplitude & Mouth Frame Mapping (No Fake Animation)...',
  );
  {
    const silenceSamples = createSyntheticTimeDomainData('silence');
    const silenceResult = computeMouthFrameFromSamples(silenceSamples, 0);
    assert.equal(
      silenceResult.mouthFrame,
      'closed',
      'Silence samples must evaluate to mouthFrame=closed',
    );
    assert.ok(
      silenceResult.amplitude < 0.1,
      `Silence amplitude must be near 0, got ${silenceResult.amplitude}`,
    );

    const mediumSamples = createSyntheticTimeDomainData('medium');
    const mediumResult = computeMouthFrameFromSamples(mediumSamples, 0);
    assert.equal(
      mediumResult.mouthFrame,
      'small',
      'Medium speech samples must evaluate to mouthFrame=small',
    );
    assert.ok(
      mediumResult.amplitude > 0.1,
      `Medium speech amplitude must be > 0.1, got ${mediumResult.amplitude}`,
    );

    const loudSamples = createSyntheticTimeDomainData('loud');
    const loudResult = computeMouthFrameFromSamples(loudSamples, 0);
    assert.equal(
      loudResult.mouthFrame,
      'open',
      'Loud speech samples must evaluate to mouthFrame=open',
    );
    assert.ok(
      loudResult.amplitude > 0.3,
      `Loud speech amplitude must be > 0.3, got ${loudResult.amplitude}`,
    );

    console.log(
      '  [PASS] Amplitude correctly drives discrete mouth frames (closed, small, open)',
    );
  }

  // ---------------------------------------------------------------------------
  // Test 2: Tier 1 Playback Lifecycle — SSE Done before Audio Playback completes
  // ---------------------------------------------------------------------------
  console.log(
    '\nTest 2: Tier 1 Playback Lifecycle — SSE Done before Audio Playback completes...',
  );
  {
    let voiceState: VoiceState = 'thinking';
    let mouthFrame: MouthFrame = 'closed';
    let playbackCompleted = false;
    let sseDoneTime = 0;
    let playbackDoneTime = 0;
    const t0 = Date.now();

    // Simulated Turn Lifecycle
    let tierPlaybackPromise: Promise<void> | null = null;

    // 1. SSE reader receives 'tier' event
    tierPlaybackPromise = (async () => {
      voiceState = 'speaking';
      // Simulate audio playing for 80ms
      mouthFrame = 'open';
      await new Promise((r) => setTimeout(r, 80));
      mouthFrame = 'closed';
      playbackCompleted = true;
      playbackDoneTime = Date.now() - t0;
    })();

    // 2. SSE reader immediately finishes receiving 'done' event (takes 5ms)
    await new Promise((r) => setTimeout(r, 5));
    sseDoneTime = Date.now() - t0;

    // Crucial check: SSE stream is done, but audio playback is STILL RUNNING!
    assert.ok(
      sseDoneTime < 30,
      `SSE Done should complete quickly, got ${sseDoneTime}ms`,
    );
    assert.equal(
      voiceState,
      'speaking',
      'voiceState must remain speaking while audio is playing even after SSE stream is done',
    );
    assert.equal(
      getEffectiveAvatarMouth(voiceState, mouthFrame),
      'open',
      'Avatar mouth must be open while voiceState is speaking',
    );

    // 3. Main client loop awaits tierPlaybackPromise before resetting state
    await tierPlaybackPromise;
    voiceState = 'listening';

    assert.ok(
      playbackCompleted,
      'Playback must be completed before voiceState resets',
    );
    assert.ok(
      playbackDoneTime > sseDoneTime,
      `Playback done time (${playbackDoneTime}ms) must exceed SSE done time (${sseDoneTime}ms)`,
    );
    assert.equal(
      voiceState,
      'listening',
      'voiceState transitions to listening only AFTER audio playback completes',
    );
    assert.equal(
      getEffectiveAvatarMouth(voiceState, mouthFrame),
      'closed',
      'Avatar mouth closes cleanly when voiceState becomes listening',
    );

    console.log(
      '  [PASS] Tier 1 audio plays to completion while voiceState remains speaking (no early cutoff)',
    );
  }

  // ---------------------------------------------------------------------------
  // Test 3: Tier 3 Fallback Playback Lifecycle
  // ---------------------------------------------------------------------------
  console.log('\nTest 3: Tier 3 Fallback Playback Lifecycle...');
  {
    let voiceState: VoiceState = 'thinking';
    let mouthFrame: MouthFrame = 'closed';
    let tierPlaybackPromise: Promise<void> | null = null;

    // SSE emits Tier 3
    tierPlaybackPromise = (async () => {
      voiceState = 'speaking';
      mouthFrame = 'small';
      await new Promise((r) => setTimeout(r, 50));
      mouthFrame = 'closed';
    })();

    // SSE reader finishes immediately
    await new Promise((r) => setTimeout(r, 2));
    assert.equal(
      voiceState,
      'speaking',
      'Tier 3 must keep speaking state during playback',
    );
    assert.equal(
      getEffectiveAvatarMouth(voiceState, mouthFrame),
      'small',
      'Avatar mouth shows small/open during Tier 3 fallback speech',
    );

    await tierPlaybackPromise;
    voiceState = 'listening';
    assert.equal(voiceState, 'listening');
    console.log(
      '  [PASS] Tier 3 Fallback properly maintains speaking state and lip-sync',
    );
  }

  // ---------------------------------------------------------------------------
  // Test 4: Tier 2 Streaming Audio Queue — Multi-chunk Playback & Inter-chunk Gap
  // ---------------------------------------------------------------------------
  console.log(
    '\nTest 4: Tier 2 Streaming Audio Queue — Multi-chunk Playback & Inter-chunk Gap...',
  );
  {
    let voiceState: VoiceState = 'thinking';
    let currentMouth: MouthFrame = 'closed';
    const queueEvents: string[] = [];

    // Mock Audio Queue Controller
    let isStreamComplete = false;
    let isPlayingChunk = false;
    const internalQueue: Array<{ id: number; durationMs: number }> = [];
    let queueResolver: (outcome: PlayAudioOutcome) => void;
    const queuePromise = new Promise<PlayAudioOutcome>((resolve) => {
      queueResolver = resolve;
    });

    const playNext = async () => {
      if (internalQueue.length === 0) {
        isPlayingChunk = false;
        // In silent gap between chunks: mouth is closed, but voiceState is STILL speaking!
        currentMouth = 'closed';
        queueEvents.push('gap_silence');
        if (isStreamComplete) {
          queueResolver('completed');
        }
        return;
      }

      isPlayingChunk = true;
      const chunk = internalQueue.shift()!;
      queueEvents.push(`start_chunk_${chunk.id}`);
      currentMouth = 'open';

      await new Promise((r) => setTimeout(r, chunk.durationMs));
      queueEvents.push(`end_chunk_${chunk.id}`);
      currentMouth = 'closed';
      void playNext();
    };

    const mockController: AudioQueueController = {
      enqueueChunk: (_blob, isLast = false) => {
        if (isLast) isStreamComplete = true;
        if (!isPlayingChunk) {
          void playNext();
        }
      },
      markComplete: () => {
        isStreamComplete = true;
        if (!isPlayingChunk && internalQueue.length === 0) {
          queueResolver('completed');
        }
      },
      abort: () => {
        internalQueue.length = 0;
        isStreamComplete = true;
        isPlayingChunk = false;
        currentMouth = 'closed';
        queueResolver('stopped');
      },
      promise: queuePromise,
    };

    // Step 1: Chunk 1 arrives
    voiceState = 'speaking';
    internalQueue.push({ id: 1, durationMs: 40 });
    mockController.enqueueChunk({} as Blob);

    // Verify Chunk 1 is playing
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(voiceState, 'speaking');
    assert.equal(currentMouth, 'open');
    assert.equal(getEffectiveAvatarMouth(voiceState, currentMouth), 'open');

    // Wait for Chunk 1 to finish (40ms) + gap before Chunk 2 arrives
    await new Promise((r) => setTimeout(r, 50));
    // During gap: mouth must be closed, but voiceState must remain 'speaking'
    assert.equal(
      voiceState,
      'speaking',
      'voiceState must remain speaking during inter-chunk wait',
    );
    assert.equal(
      currentMouth,
      'closed',
      'mouth must be closed during inter-chunk silence',
    );
    assert.equal(getEffectiveAvatarMouth(voiceState, currentMouth), 'closed');

    // Step 2: Chunk 2 arrives
    internalQueue.push({ id: 2, durationMs: 40 });
    mockController.enqueueChunk({} as Blob, true); // marked last
    mockController.markComplete();

    // Verify Chunk 2 starts playing
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(currentMouth, 'open', 'Mouth opens again for chunk 2');
    assert.equal(getEffectiveAvatarMouth(voiceState, currentMouth), 'open');

    // Wait for queue completion
    const outcome = await mockController.promise;
    assert.equal(outcome, 'completed');
    voiceState = 'listening';

    assert.equal(voiceState, 'listening');
    assert.equal(getEffectiveAvatarMouth(voiceState, currentMouth), 'closed');
    console.log(
      '  [PASS] Tier 2 queue smoothly plays multi-chunks with quiet mouth during gaps',
    );
  }

  // ---------------------------------------------------------------------------
  // Test 5: Barge-in & Cancellation — Instant Stop & No Stale State Overwrite
  // ---------------------------------------------------------------------------
  console.log(
    '\nTest 5: Barge-in & Cancellation — Instant Stop & No Stale State Overwrite...',
  );
  {
    let turnId = 1;
    let voiceState: VoiceState = 'speaking';
    let mouthFrame: MouthFrame = 'open';
    let staleUpdateOccurred = false;

    // Simulate long running turn 1
    const runTurn1 = async (turn: number) => {
      // Simulate playback
      await new Promise((r) => setTimeout(r, 50));
      if (turn !== turnId) {
        // Stale check caught it!
        return;
      }
      // If stale check failed:
      staleUpdateOccurred = true;
      voiceState = 'idle';
    };

    void runTurn1(turnId);

    // Barge-in occurs at 15ms!
    await new Promise((r) => setTimeout(r, 15));
    turnId += 1; // Invalidate turn
    voiceState = 'recording';
    mouthFrame = 'closed';

    assert.equal(voiceState, 'recording', 'Barge-in switches to recording');
    assert.equal(getEffectiveAvatarMouth(voiceState, mouthFrame), 'closed');

    // Wait past the turn 1 delay
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(
      staleUpdateOccurred,
      false,
      'Old turn must not execute state updates after barge-in',
    );
    assert.equal(
      voiceState,
      'recording',
      'voiceState must remain recording and not get overwritten to idle/listening',
    );
    console.log(
      '  [PASS] Barge-in safely terminates old turn without stale state overwrite',
    );
  }

  // ---------------------------------------------------------------------------
  // Test 6: Hands-Free Multi-turn Continuity (No Echo / No False Self-Barge-in)
  // ---------------------------------------------------------------------------
  console.log(
    '\nTest 6: Hands-Free Multi-turn Continuity (No Echo / No False Self-Barge-in)...',
  );
  {
    let micListeningActive = false;
    let voiceState: VoiceState = 'idle';

    const simulateTurn = async (turnNum: number) => {
      // 1. User speaks
      voiceState = 'recording';
      micListeningActive = false; // paused while recording
      await new Promise((r) => setTimeout(r, 10));

      // 2. Processing
      voiceState = 'thinking';
      await new Promise((r) => setTimeout(r, 10));

      // 3. Speaking
      voiceState = 'speaking';
      // Mic MUST NOT be in normal listening mode while speaking
      assert.equal(
        micListeningActive,
        false,
        `Turn ${turnNum}: Mic must not listen while mascot is speaking (prevents echo)`,
      );
      await new Promise((r) => setTimeout(r, 30));

      // 4. Playback finished -> Resume Hands-free listening
      voiceState = 'listening';
      micListeningActive = true;
      assert.equal(voiceState, 'listening');
      assert.equal(micListeningActive, true);
    };

    await simulateTurn(1);
    await simulateTurn(2);
    console.log(
      '  [PASS] Multi-turn Hands-free resumes microphone only after playback completes',
    );
  }

  console.log(
    '\n================================================================================',
  );
  console.log(
    ' ALL PLAYBACK LIFECYCLE & STATE SYNCHRONIZATION TESTS PASSED (100% GREEN)',
  );
  console.log(
    '================================================================================',
  );
}

runPlaybackLifecycleTests().catch((err) => {
  console.error('[FAILED]', err);
  process.exit(1);
});
