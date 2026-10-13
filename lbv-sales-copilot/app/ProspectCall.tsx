/**
 * Prospect Invitation & Audio-Only Call Interface
 *
 * A separate, mobile-first page rendered when a prospect opens an invitation
 * link (?join=1&sessionId=...&token=...). It NEVER renders salesperson content:
 * no recommendations, no internal notes, no provider details, no session token.
 *
 * The call is AUDIO ONLY - no camera, no video, no screen share. The backend
 * issues a prospect-scoped, microphone-only LiveKit token for the invitation.
 */

import React, { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, ConnectionState, Track } from "livekit-client";
import { Mic, MicOff, PhoneCall, PhoneOff, Loader2, AlertCircle, ShieldCheck } from "lucide-react";

type Phase =
  | "validating"
  | "invalid"
  | "ready"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended";

export default function ProspectCall() {
  const [phase, setPhase] = useState<Phase>("validating");
  const [productName, setProductName] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [micEnabled, setMicEnabled] = useState<boolean>(true);
  const [simulated, setSimulated] = useState<boolean>(false);

  const roomRef = useRef<Room | null>(null);
  const audioElementsRef = useRef<HTMLAudioElement[]>([]);

  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const sessionId = params.get("sessionId") || "";
  const inviteToken = params.get("token") || "";

  // 1. Validate the invitation (no private data is returned).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!sessionId || !inviteToken) {
        setPhase("invalid");
        setErrorMessage("This invitation link is incomplete or invalid.");
        return;
      }
      try {
        const res = await fetch(`/api/livekit/invite?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(inviteToken)}`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !data.valid) {
          setPhase("invalid");
          setErrorMessage(data.error || "This invitation is invalid or has expired.");
          return;
        }
        setProductName(data.productName || null);
        setPhase("ready");

        // Clean up sensitive invitation token from browser URL address bar & history
        if (typeof window !== "undefined" && window.history && window.history.replaceState) {
          const url = new URL(window.location.href);
          if (url.searchParams.has("token")) {
            url.searchParams.delete("token");
            window.history.replaceState({}, document.title, url.pathname + url.search);
          }
        }
      } catch (err: any) {
        if (cancelled) return;
        setPhase("invalid");
        setErrorMessage("We could not verify this invitation. Please check your connection and try again.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, inviteToken]);

  const detachAllAudio = () => {
    audioElementsRef.current.forEach((el) => {
      try {
        el.pause();
        el.remove();
      } catch {}
    });
    audioElementsRef.current = [];
  };

  const leaveCall = () => {
    try {
      roomRef.current?.disconnect();
    } catch {}
    detachAllAudio();
    roomRef.current = null;
    setPhase("ended");
  };

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      try {
        roomRef.current?.disconnect();
      } catch {}
      detachAllAudio();
    };
  }, []);

  const joinCall = async () => {
    setErrorMessage(null);
    setPhase("connecting");
    try {
      const res = await fetch("/api/livekit/invite-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, inviteToken })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "This invitation is invalid or has expired.");
      }

      if (data.mode === "simulated") {
        setSimulated(true);
        setPhase("connected");
        return;
      }

      // AUDIO-ONLY: never request or publish camera/video.
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true
        }
      });
      roomRef.current = room;

      room
        .on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
          if (state === ConnectionState.Connected) setPhase("connected");
          else if (state === ConnectionState.Reconnecting) setPhase("reconnecting");
          else if (state === ConnectionState.Disconnected) setPhase("ended");
        })
        .on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === Track.Kind.Audio) {
            const el = track.attach();
            el.autoplay = true;
            document.body.appendChild(el);
            audioElementsRef.current.push(el);
          }
        })
        .on(RoomEvent.TrackUnsubscribed, (track) => {
          try {
            track.detach();
          } catch {}
        })
        .on(RoomEvent.Disconnected, () => setPhase("ended"));

      await room.connect(data.serverUrl, data.token);
      try {
        await room.startAudio();
      } catch {}

      // Request microphone LAST so a denial produces a clear, specific error.
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        setMicEnabled(true);
      } catch (micErr: any) {
        setMicEnabled(false);
        setErrorMessage(
          "Microphone access was denied. Enable microphone permission for this site and tap Unmute to try again."
        );
      }
      setPhase("connected");
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (/NotAllowedError|Permission|denied/i.test(msg)) {
        setErrorMessage("Microphone access was denied. Please allow microphone access and try again.");
      } else {
        setErrorMessage(msg || "We could not connect to the call. Please try again.");
      }
      setPhase("ready");
    }
  };

  const toggleMic = async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      const next = !micEnabled;
      await room.localParticipant.setMicrophoneEnabled(next);
      setMicEnabled(next);
      setErrorMessage(null);
    } catch (err: any) {
      setErrorMessage("Microphone access was denied. Enable microphone permission and try again.");
    }
  };

  const statusLabel = (): string => {
    switch (phase) {
      case "validating":
        return "Checking your invitation…";
      case "connecting":
        return "Connecting to the call…";
      case "connected":
        return "Connected";
      case "reconnecting":
        return "Reconnecting…";
      case "ended":
        return "Call ended";
      default:
        return "Ready to join";
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 space-y-6">
        <div className="text-center space-y-1">
          <div className="flex items-center justify-center gap-2 text-indigo-400">
            <ShieldCheck className="w-5 h-5" />
            <span className="text-xs font-bold uppercase tracking-widest">Secure Sales Call</span>
          </div>
          <h1 className="text-xl font-bold">
            {productName ? `You're invited: ${productName}` : "You're invited to a call"}
          </h1>
          <p className="text-xs text-slate-400">
            A private, audio-only conversation. No camera or video is used.
          </p>
        </div>

        <div className="flex items-center justify-center gap-2 text-sm">
          {(phase === "validating" || phase === "connecting" || phase === "reconnecting") && (
            <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
          )}
          {phase === "connected" && <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />}
          {(phase === "invalid" || phase === "ended") && <span className="w-2.5 h-2.5 rounded-full bg-slate-500" />}
          <span className="text-slate-300">{statusLabel()}</span>
        </div>

        {errorMessage && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 text-xs text-rose-300 flex gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
        )}

        {phase === "invalid" ? (
          <div className="text-center text-xs text-slate-400">
            Ask the person who invited you to send a fresh invitation link.
          </div>
        ) : phase === "connected" || phase === "reconnecting" ? (
          <div className="space-y-3">
            <button
              onClick={toggleMic}
              className={`w-full py-3 rounded-xl font-semibold flex items-center justify-center gap-2 ${
                micEnabled ? "bg-slate-800 hover:bg-slate-700" : "bg-amber-600 hover:bg-amber-500"
              }`}
            >
              {micEnabled ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
              {micEnabled ? "Mute" : "Unmute"}
            </button>
            <button
              onClick={leaveCall}
              className="w-full py-3 rounded-xl font-semibold bg-rose-600 hover:bg-rose-500 flex items-center justify-center gap-2"
            >
              <PhoneOff className="w-5 h-5" /> Leave call
            </button>
          </div>
        ) : (
          <button
            onClick={joinCall}
            disabled={phase === "validating" || phase === "connecting"}
            className="w-full py-4 rounded-xl font-bold text-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {phase === "connecting" ? <Loader2 className="w-5 h-5 animate-spin" /> : <PhoneCall className="w-5 h-5" />}
            {phase === "ended" ? "Rejoin call" : "Join Call"}
          </button>
        )}

        {simulated && (
          <p className="text-[11px] text-amber-300 text-center">
            Simulated mode (LiveKit not configured in this environment).
          </p>
        )}
        <p className="text-[11px] text-slate-500 text-center">
          Audio only. We never request camera or video access.
        </p>
      </div>
    </div>
  );
}
