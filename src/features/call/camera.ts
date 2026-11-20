"use client";
/**
 * Camera is a video-only stream, separate from the voice SDK's microphone.
 * Turning it off stops video tracks only; audio is untouched.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type Facing = "user" | "environment";
export type CameraState = "off" | "starting" | "on" | "denied" | "unavailable" | "error";

export function stopTracks(stream: Pick<MediaStream, "getTracks"> | null | undefined) {
  stream?.getTracks().forEach(t => t.stop());
}

export function cameraConstraints(facing: Facing): MediaStreamConstraints {
  return { audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } } };
}

export function classifyCameraError(err: unknown): CameraState {
  const name = err instanceof Error || (err && typeof err === "object" && "name" in err) ? String((err as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") return "unavailable";
  return "error";
}

/** Draws the current frame to a canvas, longest edge capped, JPEG. */
export function captureFrame(video: HTMLVideoElement, maxEdge = 1080): Promise<Blob> {
  const { videoWidth: w, videoHeight: h } = video;
  if (!w || !h) return Promise.reject(new Error("Camera isn't showing a picture yet."));
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("Couldn't capture a still."));
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Couldn't capture a still."))), "image/jpeg", 0.9),
  );
}

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const [state, setState] = useState<CameraState>("off");
  const [facing, setFacing] = useState<Facing>("environment");
  const [canSwitch, setCanSwitch] = useState(false);

  const release = useCallback(() => {
    stopTracks(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const start = useCallback(async (nextFacing: Facing = facing) => {
    const gen = ++generation.current;
    release();
    if (!navigator.mediaDevices?.getUserMedia) return setState("unavailable");
    setState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(nextFacing));
      // Turned off (or restarted) while permission prompt was open: discard.
      if (gen !== generation.current) return stopTracks(stream);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setFacing(nextFacing);
      setState("on");
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      setCanSwitch(devices.filter(d => d.kind === "videoinput").length > 1);
    } catch (err) {
      if (gen === generation.current) setState(classifyCameraError(err));
    }
  }, [facing, release]);

  const stop = useCallback(() => {
    generation.current++;
    release();
    setState("off");
  }, [release]);

  const flip = useCallback(() => start(facing === "user" ? "environment" : "user"), [facing, start]);

  const grab = useCallback(() => {
    if (state !== "on" || !videoRef.current) return Promise.reject(new Error("Camera is off."));
    return captureFrame(videoRef.current);
  }, [state]);

  useEffect(() => () => { generation.current++; release(); }, [release]);

  return { videoRef, state, facing, canSwitch, start, stop, flip, grab };
}
