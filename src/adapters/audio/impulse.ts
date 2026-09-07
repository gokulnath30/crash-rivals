/**
 * A synthesised impulse response for the arena reverb.
 *
 * Loading a real impulse response would mean shipping an audio file; a decayed
 * noise burst is a few lines of maths and, for a dark concrete room with a
 * crowd in it, close enough that nobody would pick it out of a line-up.
 *
 * The two channels get independent noise, which is what makes the tail sound
 * wide rather than like a mono echo pasted across both ears.
 */
export function createArenaImpulse(context: BaseAudioContext, seconds = 2.2): AudioBuffer {
  const rate = context.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const impulse = context.createBuffer(2, length, rate);

  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const samples = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const progress = i / length;
      // An exponential decay with a slight early build, so the tail blooms
      // instead of starting at full blast like a gunshot.
      const envelope = Math.pow(1 - progress, 2.6) * Math.min(1, progress * 40);
      samples[i] = (Math.random() * 2 - 1) * envelope;
    }
  }

  return impulse;
}

/**
 * White noise, one second of it, reused by every noise-based voice rather than
 * generating a fresh buffer per punch.
 */
export function createNoiseBuffer(context: BaseAudioContext, seconds = 1): AudioBuffer {
  const rate = context.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = context.createBuffer(1, length, rate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) samples[i] = Math.random() * 2 - 1;
  return buffer;
}
