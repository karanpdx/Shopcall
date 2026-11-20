/** Probe only after an explicit Start click; release temporary audio before SDK owns its input. */
export async function checkMicrophone(devices: Pick<MediaDevices, "getUserMedia"> | undefined): Promise<string | null> {
  if (!devices?.getUserMedia) return "Microphone access is unavailable. Open Shopcall in a secure browser tab and connect a microphone.";
  try {
    const probe = await devices.getUserMedia({ audio: true, video: false });
    probe.getTracks().forEach(track => track.stop());
    return null;
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked. Allow microphone access in your browser's site settings, then tap Start call again. Camera can stay off.";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. Connect or enable a microphone, then tap Start call again.";
    if (name === "NotReadableError" || name === "AbortError") return "Your microphone could not open. Close other apps using it, check your device settings, and retry.";
    return "Microphone could not start. Check your browser's microphone permission and retry; your drafts remain saved.";
  }
}
