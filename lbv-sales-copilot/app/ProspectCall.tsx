/**
 * Prospect Invitation & Audio-Only Call Interface
 *
 * A separate, mobile-first page rendered when a prospect opens an invitation
 * link (?join=1&sessionId=...&token=...). It NEVER renders salesperson content:
 * no recommendations, no internal notes, no provider details, no session token.
 *
 * The call is AUDIO ONLY — no camera, no video, no screen share. The backend
 * issues a prospect-scoped, microphone-only LiveKit token for the invitation.
 *
 * SECURITY
 * - The invitation token is captured once and removed from the visible URL as
 *   soon as it is validated; it is never persisted to browser storage.
 * - Only a prospect-scoped token is ever requested; the client cannot ask for
 *   the salesperson identity or elevated permissions.
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
  const joiningRef = useRef<boolean>(false);

  // Capture the invitation ONCE (the URL is rewritten after validation so the
  // token does not linger in the address bar / history / referrer).
  const [invite] = useState(() => {
    const p =
      typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
    return { sessionId: p.get("sessionId") || "", token: p.get("token") || "" };
  });
  const sessionId = invite.sessionId;
  const inviteToken = invite.token;

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
        const res = await fetch(
          `/api/livekit/invite?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(inviteToken)}`
        );
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !data.valid) {
          setPhase("invalid");
          setErrorMessage(data.error || "This invitation is invalid or has expired.");
          return;
        }
        setProductName(data.productName || null);
        // Remove the invitation token from the address bar/history now that it
        // has been validated (reduces exposure via history, screenshots, referrer).
        try {
          if (typeof window !== "undefined" && window.location.search.includes("token=")) {
            window.history.replaceState({}, "", `${window.location.pathname}?join=1`);
          }
        } catch {
          /* ignore history failures */
        }
        setPhase("ready");
      } catch {
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
      } catch {
        /* ignore */
      }
    });
    audioElementsRef.current = [];
  };

  const leaveCall = () => {
    try {
      roomRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    detachAllAudio();
    roomRef.current = null;
    joiningRef.current = false;
    setPhase("ended");
  };

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      try {
        roomRef.current?.disconnect();
      } catch {
        /* ignore */
      }
      detachAllAudio();
    };
  }, []);

  const joinCall = async () => {
    // Guard against accidental duplicate connections / repeated submissions.
    if (joiningRef.current || phase === "connecting") return;
    joiningRef.current = true;

    setErrorMessage(null);
    setPhase("connecting");

    try {
      const res = await fetch("/api/livekit/invite-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, inviteToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "This invitation is invalid or has expired.");
      }

      if (data.mode === "simulated") {
        setSimulated(true);
        setPhase("connected");
        joiningRef.current = false;
        return;
      }

      // AUDIO-ONLY: never request or publish camera/video.
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
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
          } catch {
            /* ignore */
          }
        })
        .on(RoomEvent.Disconnected, () => setPhase("ended"));

      await room.connect(data.serverUrl, data.token);
      try {
        await room.startAudio();
      } catch {
        /* autoplay may require a user gesture; the join tap provides one */
      }

      // Request the microphone LAST so a denial produces a clear, specific error.
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        setMicEnabled(true);
      } catch {
        setMicEnabled(false);
        setErrorMessage(
          "Microphone access was denied. Enable microphone permission for this site, then tap Unmute."
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
    } finally {
      joiningRef.current = false;
    }
  };

  const toggleMic = async () => {
    const room = roomRef.current;
    if (!room) {
      // Simulated mode: toggle the visual state only.
      setMicEnabled((prev) => !prev);
      return;
    }
    try {
      const next = !micEnabled;
      await room.localParticipant.setMicrophoneEnabled(next);
      setMicEnabled(next);
      setErrorMessage(null);
    } catch {
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
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-8 text-ink">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-line bg-surface p-6 shadow-2xl sm:p-8">
        <div className="flex items-center justify-center gap-2 text-brand">
          <ShieldCheck className="h-4 w-4" />
          <span className="text-[11px] font-semibold uppercase tracking-widest">Secure audio call</span>
        </div>

        <div className="space-y-1.5 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            {productName ? `You're invited: ${productName}` : "You're invited to a call"}
          </h1>
          <p className="text-[13px] text-ink-soft">
            A private, audio-only conversation. No camera or video is used.
          </p>
        </div>

        <div className="flex items-center justify-center gap-2 text-[13px]">
          {(phase === "validating" || phase === "connecting" || phase === "reconnecting") && (
            <Loader2 className="h-4 w-4 animate-spin text-brand" />
          )}
          {phase === "connected" && (
            <span className="relative inline-block h-2.5 w-2.5 rounded-full bg-positive lbv-live-dot" />
          )}
          {(phase === "invalid" || phase === "ended") && (
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-ink-mute" />
          )}
          <span className="text-ink-soft">{statusLabel()}</span>
        </div>

        {errorMessage && (
          <div className="flex items-start gap-2.5 rounded-lg border border-danger/35 bg-danger/10 px-3.5 py-3 text-[13px] text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {phase === "invalid" ? (
          <div className="rounded-lg border border-line bg-surface-2/50 px-4 py-4 text-center text-[13px] text-ink-soft">
            Ask the person who invited you to send a fresh invitation link.
          </div>
        ) : phase === "connected" || phase === "reconnecting" ? (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => void toggleMic()}
              aria-pressed={!micEnabled}
              className={`flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-[15px] font-semibold transition-colors cursor-pointer ${
                micEnabled
                  ? "border border-line-strong bg-surface-2 text-ink hover:bg-surface-3"
                  : "border border-warn/40 bg-warn/15 text-warn"
              }`}
            >
              {micEnabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
              {micEnabled ? "Mute microphone" : "Unmute microphone"}
            </button>
            <button
              type="button"
              onClick={leaveCall}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-danger bg-danger py-3.5 text-[15px] font-semibold text-[#2a0b12] transition-colors hover:brightness-110 cursor-pointer"
            >
              <PhoneOff className="h-5 w-5" />
              Leave call
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void joinCall()}
            disabled={phase === "validating" || phase === "connecting"}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-brand-strong bg-brand-strong py-4 text-[16px] font-semibold text-white transition-colors hover:bg-brand disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
          >
            {phase === "connecting" ? <Loader2 className="h-5 w-5 animate-spin" /> : <PhoneCall className="h-5 w-5" />}
            {phase === "connecting" ? "Connecting…" : phase === "ended" ? "Rejoin call" : "Join call"}
          </button>
        )}

        {simulated && (
          <p className="text-center text-[11px] text-warn">
            Simulated mode — LiveKit is not configured in this environment.
          </p>
        )}

        <p className="text-center text-[11px] text-ink-mute">
          Audio only. We never request camera or video access.
        </p>
      </div>
    </div>
  );
}

