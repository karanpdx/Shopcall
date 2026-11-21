import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

/** Server-only: import from route handlers, jobs, or scripts, never browser modules. */
export function createElevenLabsClient() {
  if (typeof window !== "undefined") {
    throw new Error("ElevenLabs API client is server-only.");
  }
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is missing. Run ElevenLabs onboarding first.");
  }
  return new ElevenLabsClient();
}
