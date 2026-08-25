import { GoogleGenAI, Scale } from "@google/genai";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "public", "audio", "promo-score.wav");

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("GEMINI_API_KEY not set");
  process.exit(1);
}

// Beat schedule matches the Remotion scene cuts exactly (at 30fps):
// Scene1 0-150f, Scene2 150-215f, Scene3&4 215-475f, Scene5 475-705f, Scene6 705-815f
const SEC_PER_FRAME = 1 / 30;
const beats = [
  {
    atSec: 0,
    label: "tension (Slack pain)",
    prompts: [
      { text: "tense minimal ambient synth pad", weight: 1.0 },
      { text: "sparse anxious atmosphere, quiet and unresolved", weight: 0.8 },
    ],
    config: {
      bpm: 78,
      scale: Scale.A_FLAT_MAJOR_F_MINOR,
      density: 0.2,
      brightness: 0.22,
      guidance: 4.5,
      temperature: 1.0,
    },
    reset: false,
  },
  {
    atSec: 150 * SEC_PER_FRAME, // 5.0s — "YES, YOU CAN." sting
    label: "hit / reveal",
    prompts: [
      { text: "sudden bright rising synth riser", weight: 1.0 },
      { text: "triumphant confident synth chord hit", weight: 0.9 },
      { text: "uplifting swell", weight: 0.7 },
    ],
    config: {
      bpm: 112,
      scale: Scale.D_MAJOR_B_MINOR,
      density: 0.55,
      brightness: 0.8,
      guidance: 4.5,
      temperature: 1.1,
    },
    reset: true,
  },
  {
    atSec: 215 * SEC_PER_FRAME, // 7.1667s — terminal / MCP build
    label: "build (terminal)",
    prompts: [
      { text: "driving plucked synth bassline", weight: 1.0 },
      { text: "steady clap beat, optimistic energy building", weight: 0.9 },
    ],
    config: {
      bpm: 118,
      scale: Scale.D_MAJOR_B_MINOR,
      density: 0.6,
      brightness: 0.82,
      guidance: 4.5,
      temperature: 1.1,
    },
    reset: false,
  },
  {
    atSec: 345 * SEC_PER_FRAME, // 11.5s — mid-build intensify (tool calls firing)
    label: "build intensify",
    prompts: [
      { text: "driving plucked synth bassline", weight: 0.8 },
      { text: "steady clap beat, energy building", weight: 0.8 },
      { text: "layered arpeggios rising toward a climax, anticipation", weight: 0.9 },
    ],
    config: {
      bpm: 118,
      scale: Scale.D_MAJOR_B_MINOR,
      density: 0.78,
      brightness: 0.92,
      guidance: 4.5,
      temperature: 1.1,
    },
    reset: false,
  },
  {
    atSec: 475 * SEC_PER_FRAME, // 15.8333s — gallery payoff climax
    label: "payoff climax",
    prompts: [
      { text: "warm triumphant chord progression, joyful and full", weight: 1.0 },
      { text: "celebratory bright synths, confident and satisfying", weight: 0.9 },
    ],
    config: {
      bpm: 122,
      scale: Scale.G_MAJOR_E_MINOR,
      density: 0.85,
      brightness: 0.95,
      guidance: 4.5,
      temperature: 1.1,
    },
    reset: true,
  },
  {
    atSec: 655 * SEC_PER_FRAME, // 21.8333s — Mei's happy reply bubble
    label: "playful accent",
    prompts: [
      { text: "warm triumphant chord progression, joyful and full", weight: 0.8 },
      { text: "bright playful melodic accent, delighted", weight: 0.9 },
    ],
    config: {
      bpm: 122,
      scale: Scale.G_MAJOR_E_MINOR,
      density: 0.82,
      brightness: 1.0,
      guidance: 4.5,
      temperature: 1.1,
    },
    reset: false,
  },
  {
    atSec: 705 * SEC_PER_FRAME, // 23.5s — outro resolve
    label: "outro resolve",
    prompts: [
      { text: "warm sustained pad, gentle satisfying resolve", weight: 1.0 },
      { text: "soft fading outro, peaceful confident close", weight: 0.8 },
    ],
    config: {
      bpm: 92,
      scale: Scale.G_MAJOR_E_MINOR,
      density: 0.28,
      brightness: 0.5,
      guidance: 4.5,
      temperature: 1.0,
    },
    reset: true,
  },
];

const STOP_AT_SEC = 815 * SEC_PER_FRAME + 1.5; // small tail past the last frame

async function main() {
  const client = new GoogleGenAI({ apiKey: API_KEY, apiVersion: "v1alpha" });

  const chunks = [];
  let totalBytes = 0;
  let sampleRate = 48000;
  const channels = 2;
  const bytesPerSample = 2;

  let nextBeatIndex = 1; // beat 0 is applied before play()
  let stopped = false;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));

  const session = await client.live.music.connect({
    model: "models/lyria-realtime-exp",
    callbacks: {
      onmessage: async (message) => {
        const audioChunks = message.serverContent?.audioChunks;
        if (!audioChunks) return;
        for (const chunk of audioChunks) {
          if (!chunk.data) continue;
          const match = /rate=(\d+)/.exec(chunk.mimeType || "");
          if (match) sampleRate = parseInt(match[1], 10);
          const buf = Buffer.from(chunk.data, "base64");
          chunks.push(buf);
          totalBytes += buf.length;

          const elapsedSec = totalBytes / (sampleRate * channels * bytesPerSample);
          console.log(`elapsed ${elapsedSec.toFixed(2)}s (${(totalBytes / 1e6).toFixed(2)}MB)`);

          while (nextBeatIndex < beats.length && elapsedSec >= beats[nextBeatIndex].atSec) {
            const beat = beats[nextBeatIndex];
            console.log(`--> beat: ${beat.label} @ ${elapsedSec.toFixed(2)}s`);
            await session.setWeightedPrompts({ weightedPrompts: beat.prompts });
            await session.setMusicGenerationConfig({ musicGenerationConfig: beat.config });
            if (beat.reset) session.resetContext();
            nextBeatIndex += 1;
          }

          if (!stopped && elapsedSec >= STOP_AT_SEC) {
            stopped = true;
            session.stop();
            session.close();
            resolveDone();
          }
        }
      },
      onerror: (e) => console.error("session error:", e),
      onclose: () => {
        console.log("session closed");
        resolveDone();
      },
    },
  });

  await session.setWeightedPrompts({ weightedPrompts: beats[0].prompts });
  await session.setMusicGenerationConfig({ musicGenerationConfig: beats[0].config });
  session.play();

  await done;

  const pcm = Buffer.concat(chunks);
  const wav = wrapWav(pcm, sampleRate, channels, 16);
  writeFileSync(OUT_PATH, wav);
  console.log(`wrote ${OUT_PATH} (${(wav.length / 1e6).toFixed(2)}MB, ${sampleRate}Hz)`);
}

function wrapWav(pcmData, sampleRate, numChannels, bitsPerSample) {
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmData.length, 40);
  return Buffer.concat([header, pcmData]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
