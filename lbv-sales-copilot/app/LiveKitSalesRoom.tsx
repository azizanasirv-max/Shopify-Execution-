/**
 * Live Sales Room (salesperson workspace)
 *
 * Connects the salesperson to the LiveKit Cloud room bound to their session,
 * forwards FINAL prospect transcript segments to the Worker, and renders the
 * approval-gated "Say this next" recommendation.
 *
 * SECURITY / CORRECTNESS INVARIANTS (preserved from the original implementation)
 * - Only FINAL prospect segments are forwarded; segments are de-duplicated by id.
 * - A monotonic request sequence + AbortController reject stale/superseded
 *   recommendation responses so out-of-order text can never be displayed.
 * - Streaming only renders text emitted by the backend AFTER the deterministic
 *   approval gate; the non-streaming route is the fallback and is equally gated.
 * - Recommendations render only in the salesperson's interface; nothing is
 *   published to the room and no token is written to browser storage.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  Track,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  LocalParticipant,
  ConnectionState,
} from "livekit-client";
import {
  Radio,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Shield,
  AlertCircle,
  Volume2,
  RefreshCw,
  Sparkles,
  Server,
} from "lucide-react";
import { segmentText, shouldForwardProspectSegment } from "../../src/sales/transcriptFilter";

export interface LiveKitSalesRoomProps {
  sessionId?: string | null;
  sessionToken?: string | null;
  productId?: string;
  /** Prebuilt prospect invitation URL (scoped invite token) owned by the parent. */
  inviteUrl?: string | null;
  /** Called when the room connects successfully. */
  onJoined?: () => void;
  /** Called when the room disconnects (leave or network drop). */
  onLeft?: () => void;
  /** Called after "End Session" revokes the session and its invitation. */
  onEnded?: () => void;
}

interface ParticipantAudioState {
  identity: string;
  name?: string;
  isLocal: boolean;
  isSpeaking: boolean;
  isAudioEnabled: boolean;
}

type RecommendationStatus = "APPROVED" | "RECOVERY_REQUIRED" | "BLOCKED";

interface Recommendation {
  statement: string;
  status: RecommendationStatus;
  timestamp: number;
}

interface TranscriptLine {
  text: string;
  timestamp: number;
}

/** Minimal Server-Sent Events parser for the streaming recommendation endpoint. */
function parseSseEvent(rawEvent: string): { event: string; data: any } | null {
  const lines = rawEvent.split("\n");
  let event = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case ConnectionState.Connected:
      return "Connected";
    case ConnectionState.Connecting:
      return "Connecting";
    case ConnectionState.Reconnecting:
      return "Reconnecting";
    default:
      return "Disconnected";
  }
}

export default function LiveKitSalesRoom({
  sessionId: propSessionId,
  sessionToken: propSessionToken,
  productId: propProductId = "shopify-conversion-pilot",
  inviteUrl = null,
  onJoined,
  onLeft,
  onEnded,
}: LiveKitSalesRoomProps = {}) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(propSessionId || null);
  const [activeSessionToken, setActiveSessionToken] = useState<string | null>(propSessionToken || null);
  const activeProductId = propProductId;
  const [roomName, setRoomName] = useState<string>("");

  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSimulatedMode, setIsSimulatedMode] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isMicEnabled, setIsMicEnabled] = useState(true);
  const [participants, setParticipants] = useState<ParticipantAudioState[]>([]);
  const [callEnded, setCallEnded] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);

  const [serverConfig, setServerConfig] = useState<{
    configured: boolean;
    serverUrl: string | null;
    hasApiKey: boolean;
    hasApiSecret: boolean;
  } | null>(null);
  const [checkingConfig, setCheckingConfig] = useState(true);

  const [currentRecommendation, setCurrentRecommendation] = useState<Recommendation | null>(null);
  const [isProcessingTranscript, setIsProcessingTranscript] = useState(false);
  const [prospectTranscripts, setProspectTranscripts] = useState<TranscriptLine[]>([]);

  const processedSegmentIdsRef = useRef<Set<string>>(new Set());
  const monotonicReqSeqRef = useRef<number>(0);
  const activeAbortRef = useRef<AbortController | null>(null);
  const roomRef = useRef<Room | null>(null);
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  // Keep parent-provided credentials in sync (the parent owns the session).
  useEffect(() => {
    if (propSessionId) setActiveSessionId(propSessionId);
    if (propSessionToken) setActiveSessionToken(propSessionToken);
  }, [propSessionId, propSessionToken]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [prospectTranscripts.length]);

  const checkServerConfiguration = useCallback(async () => {
    setCheckingConfig(true);
    try {
      const res = await fetch("/api/livekit/status");
      setServerConfig(
        res.ok
          ? await res.json()
          : { configured: false, serverUrl: null, hasApiKey: false, hasApiSecret: false }
      );
    } catch {
      setServerConfig({ configured: false, serverUrl: null, hasApiKey: false, hasApiSecret: false });
    } finally {
      setCheckingConfig(false);
    }
  }, []);

  const updateParticipantsList = useCallback((room: Room, micEnabled: boolean) => {
    const list: ParticipantAudioState[] = [];

    if (room.localParticipant) {
      const localMicTrack = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      list.push({
        identity: room.localParticipant.identity,
        name: room.localParticipant.name || room.localParticipant.identity,
        isLocal: true,
        isSpeaking: room.localParticipant.isSpeaking,
        isAudioEnabled: localMicTrack ? !localMicTrack.isMuted : micEnabled,
      });
    }

    room.remoteParticipants.forEach((p) => {
      const micPub = p.getTrackPublication(Track.Source.Microphone);
      list.push({
        identity: p.identity,
        name: p.name || p.identity,
        isLocal: false,
        isSpeaking: p.isSpeaking,
        isAudioEnabled: micPub ? !micPub.isMuted : false,
      });
    });

    setParticipants(list);
  }, []);

  const disconnectRoom = useCallback(() => {
    if (roomRef.current) {
      roomRef.current.disconnect();
      roomRef.current = null;
    }
    audioElementsRef.current.forEach((el) => el.remove());
    audioElementsRef.current.clear();
    setConnectionState(ConnectionState.Disconnected);
    setParticipants([]);
    setIsConnecting(false);
    setIsSimulatedMode(false);
  }, []);

  useEffect(() => {
    void checkServerConfiguration();
    return () => disconnectRoom();
  }, [checkServerConfiguration, disconnectRoom]);



  /**
   * Forward one final prospect segment to the Worker and render the
   * approval-gated recommendation. Stale responses are discarded via a
   * monotonic sequence counter and an AbortController.
   */
  const processProspectTranscript = useCallback(
    async (text: string, segmentId: string, sessionId: string, sessionToken: string | null) => {
      setProspectTranscripts((prev) => [...prev.slice(-49), { text, timestamp: Date.now() }]);

      monotonicReqSeqRef.current += 1;
      const reqSeq = monotonicReqSeqRef.current;

      activeAbortRef.current?.abort();
      const controller = new AbortController();
      activeAbortRef.current = controller;

      setIsProcessingTranscript(true);
      setErrorMessage(null);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(sessionToken ? { "x-session-token": sessionToken } : {}),
      };
      const body = JSON.stringify({ sessionId, sessionToken, text, isFinal: true, speaker: "prospect" });

      try {
        let streamingSucceeded = false;

        // Preferred path: stream text the backend has ALREADY validated.
        try {
          const streamRes = await fetch("/api/livekit/transcript/stream", {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          });

          if (streamRes.ok && streamRes.body) {
            const reader = streamRes.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let accumulated = "";
            let streamDone = false;

            while (!streamDone) {
              const chunk = await reader.read();
              streamDone = chunk.done;
              if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });

              const frames = buffer.split("\n\n");
              buffer = frames.pop() || "";

              for (const frame of frames) {
                const parsed = parseSseEvent(frame);
                if (!parsed) continue;

                if (parsed.event === "delta") {
                  if (reqSeq === monotonicReqSeqRef.current && parsed.data?.text) {
                    accumulated += parsed.data.text;
                    setCurrentRecommendation({
                      statement: accumulated,
                      status: "APPROVED",
                      timestamp: Date.now(),
                    });
                    setIsProcessingTranscript(false);
                    streamingSucceeded = true;
                  }
                } else if (parsed.event === "final") {
                  const rec = parsed.data?.recommendation;
                  if (reqSeq === monotonicReqSeqRef.current && rec) {
                    setCurrentRecommendation({
                      statement: rec.statement,
                      status: rec.status,
                      timestamp: Date.now(),
                    });
                    streamingSucceeded = true;
                  }
                } else if (parsed.event === "error") {
                  throw new Error(parsed.data?.error || "Streaming recommendation failed.");
                }
              }
            }
          }

          if (!streamingSucceeded) throw new Error("Streaming response produced no recommendation.");
        } catch (streamErr: any) {
          if (streamErr?.name === "AbortError") throw streamErr;
          console.warn("Streaming recommendation unavailable, falling back:", streamErr?.message || streamErr);
        }

        // Non-streaming fallback (same approval gate server-side).
        if (!streamingSucceeded) {
          const res = await fetch("/api/livekit/transcript", {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          });

          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            processedSegmentIdsRef.current.delete(segmentId);
            setErrorMessage(
              errData.error || errData.message || `Transcript processing failed (status ${res.status}).`
            );
          } else {
            const data = await res.json();
            if (reqSeq === monotonicReqSeqRef.current && data.recommendation) {
              setCurrentRecommendation({
                statement: data.recommendation.statement,
                status: data.recommendation.status,
                timestamp: Date.now(),
              });
            }
          }
        }
      } catch (txErr: any) {
        if (txErr?.name !== "AbortError") {
          processedSegmentIdsRef.current.delete(segmentId);
          setErrorMessage("Network error while processing the transcript: " + (txErr.message || txErr));
        }
      } finally {
        if (reqSeq === monotonicReqSeqRef.current) setIsProcessingTranscript(false);
      }
    },
    []
  );

  const handleJoinRoom = async () => {
    setErrorMessage(null);
    setCallEnded(false);
    setIsConnecting(true);

    try {
      let currentSessionId = activeSessionId;
      let currentSessionToken = activeSessionToken;

      // Establish an authorized session if the parent did not supply one.
      if (!currentSessionId || !currentSessionToken) {
        const sessRes = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId: activeProductId }),
        });
        if (!sessRes.ok) {
          const sessErr = await sessRes.json().catch(() => ({}));
          throw new Error(sessErr.error || "Failed to create a sales session.");
        }
        const sessData = await sessRes.json();
        currentSessionId = sessData.sessionId;
        currentSessionToken = sessData.sessionToken;
        setActiveSessionId(sessData.sessionId);
        setActiveSessionToken(sessData.sessionToken);
        if (sessData.roomName) setRoomName(sessData.roomName);
      }

      // 1. Mint a server-governed participant token (salesperson identity only).
      const effectiveName = "Sales Representative";
      const res = await fetch("/api/livekit/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(currentSessionToken ? { "x-session-token": currentSessionToken } : {}),
        },
        body: JSON.stringify({
          sessionId: currentSessionId,
          sessionToken: currentSessionToken,
          productId: activeProductId,
          identity: "salesperson",
          name: effectiveName,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || errData.error || `Server returned ${res.status}`);
      }

      const { token, serverUrl, roomName: serverRoom, mode } = await res.json();
      if (serverRoom) setRoomName(serverRoom);

      // Simulated mode (local/dev only, never production).
      if (mode === "simulated") {
        setIsSimulatedMode(true);
        setConnectionState(ConnectionState.Connected);
        setIsConnecting(false);
        setParticipants([
          {
            identity: "salesperson",
            name: effectiveName,
            isLocal: true,
            isSpeaking: false,
            isAudioEnabled: isMicEnabled,
          },
          { identity: "prospect", name: "Prospect (simulated)", isLocal: false, isSpeaking: false, isAudioEnabled: true },
        ]);
        onJoined?.();
        return;
      }

      // 2. Connect to the LiveKit Cloud room.
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: { autoGainControl: true, echoCancellation: true, noiseSuppression: true },
      });
      roomRef.current = room;

      room
        .on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
          setConnectionState(state);
          if (state === ConnectionState.Connected) setIsConnecting(false);
          else if (state === ConnectionState.Disconnected) {
            setIsConnecting(false);
            setParticipants([]);
          }
        })
        .on(RoomEvent.ParticipantConnected, () => updateParticipantsList(room, isMicEnabled))
        .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
          const el = audioElementsRef.current.get(participant.identity);
          if (el) {
            el.remove();
            audioElementsRef.current.delete(participant.identity);
          }
          updateParticipantsList(room, isMicEnabled);
        })
        .on(
          RoomEvent.TrackSubscribed,
          (track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) => {
            if (track.kind === Track.Kind.Audio) {
              const audioElement = track.attach();
              audioElement.autoplay = true;
              audioElementsRef.current.set(participant.identity, audioElement);
            }
            updateParticipantsList(room, isMicEnabled);
          }
        )
        .on(
          RoomEvent.TrackUnsubscribed,
          (track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) => {
            if (track.kind === Track.Kind.Audio) {
              track.detach();
              const el = audioElementsRef.current.get(participant.identity);
              if (el) {
                el.remove();
                audioElementsRef.current.delete(participant.identity);
              }
            }
            updateParticipantsList(room, isMicEnabled);
          }
        )
        .on(RoomEvent.ActiveSpeakersChanged, () => updateParticipantsList(room, isMicEnabled))
        .on(RoomEvent.TrackMuted, () => updateParticipantsList(room, isMicEnabled))
        .on(RoomEvent.TrackUnmuted, () => updateParticipantsList(room, isMicEnabled))
        .on(RoomEvent.Disconnected, () => {
          setConnectionState(ConnectionState.Disconnected);
          setParticipants([]);
          onLeft?.();
        });


      // Forward FINAL prospect transcription segments to the approval gate.
      if ((RoomEvent as any).TranscriptionReceived) {
        room.on(
          (RoomEvent as any).TranscriptionReceived,
          async (transcriptions: any[], participant?: RemoteParticipant | LocalParticipant) => {
            if (!transcriptions || transcriptions.length === 0) return;

            for (const publication of transcriptions) {
              const text = segmentText(publication);
              const segmentId =
                publication.id ||
                publication.segmentId ||
                `seg_${publication.participantIdentity || participant?.identity || "p"}_${Date.now()}_${Math.random()
                  .toString(36)
                  .substring(2, 7)}`;

              // Only FINAL, non-empty segments spoken by the prospect are
              // forwarded; the salesperson's own speech and interim segments are
              // dropped. Rules live in src/sales/transcriptFilter.ts.
              if (!shouldForwardProspectSegment(publication, participant?.identity)) continue;
              if (processedSegmentIdsRef.current.has(segmentId)) continue;

              processedSegmentIdsRef.current.add(segmentId);
              void processProspectTranscript(text.trim(), segmentId, currentSessionId!, currentSessionToken);
            }
          }
        );
      }

      await room.connect(serverUrl, token);

      try {
        await room.startAudio();
      } catch (audioErr) {
        console.warn("Audio autoplay restriction on startAudio:", audioErr);
      }

      // Attach already-subscribed remote audio (prospect joined first).
      room.remoteParticipants.forEach((p) => {
        p.trackPublications.forEach((pub) => {
          if (pub.track && pub.track.kind === Track.Kind.Audio && !audioElementsRef.current.has(p.identity)) {
            const el = pub.track.attach();
            el.autoplay = true;
            audioElementsRef.current.set(p.identity, el);
          }
        });
      });

      // Publish the local microphone.
      try {
        await room.localParticipant.setMicrophoneEnabled(isMicEnabled);
      } catch (micErr: any) {
        console.warn("Microphone permission was denied or failed:", micErr);
        setErrorMessage(
          "Microphone permission was denied or the device is unavailable. You are connected as a listener, but your microphone audio will not be broadcast."
        );
      }

      updateParticipantsList(room, isMicEnabled);
      onJoined?.();
    } catch (err: any) {
      console.error("LiveKit connection error:", err);
      let userFriendlyMessage = err.message || "Failed to connect to the LiveKit room.";
      if (userFriendlyMessage.includes("UNAUTHORIZED") || userFriendlyMessage.includes("Unauthorized")) {
        userFriendlyMessage = "Unauthorized session: the session token is invalid or does not match this session.";
      } else if (userFriendlyMessage.includes("SESSION_NOT_FOUND") || userFriendlyMessage.includes("not found")) {
        userFriendlyMessage = "Session expired or not found. Please start a new sales session.";
      } else if (userFriendlyMessage.includes("MISMATCHED_SESSION_PRODUCT")) {
        userFriendlyMessage = "Product mismatch: this session belongs to another product and cannot join this room.";
      } else if (
        userFriendlyMessage.includes("network") ||
        userFriendlyMessage.includes("WebSocket") ||
        userFriendlyMessage.includes("failed to connect")
      ) {
        userFriendlyMessage = "Network connection failed. Unable to connect to LiveKit Cloud. Check your connection.";
      }
      setErrorMessage(userFriendlyMessage);
      setIsConnecting(false);
      setConnectionState(ConnectionState.Disconnected);
    }
  };



  const handleToggleMic = async () => {
    if (isSimulatedMode) {
      const nextState = !isMicEnabled;
      setIsMicEnabled(nextState);
      setParticipants((prev) => prev.map((p) => (p.isLocal ? { ...p, isAudioEnabled: nextState } : p)));
      return;
    }

    if (!roomRef.current || roomRef.current.state !== ConnectionState.Connected) {
      setIsMicEnabled(!isMicEnabled);
      return;
    }

    try {
      const nextState = !isMicEnabled;
      await roomRef.current.localParticipant.setMicrophoneEnabled(nextState);
      setIsMicEnabled(nextState);
      updateParticipantsList(roomRef.current, nextState);
    } catch (e: any) {
      setErrorMessage("Could not toggle the microphone: " + e.message);
    }
  };

  /** Leave the room without revoking the session (the prospect link stays valid). */
  const handleLeaveRoom = () => {
    disconnectRoom();
    setCallEnded(false);
  };

  /** Copy the prospect invitation link (parent-owned link preferred). */
  const handleCopyInviteLink = async () => {
    try {
      let url = inviteUrl;
      if (!url && activeSessionId && activeSessionToken) {
        const res = await fetch(`/api/sessions?sessionId=${encodeURIComponent(activeSessionId)}`, {
          headers: { "x-session-token": activeSessionToken },
        });
        if (res.ok) {
          const data = await res.json();
          const inviteToken = data?.sessions?.[0]?.inviteToken;
          if (inviteToken) {
            url = `${window.location.origin}${window.location.pathname}?join=1&sessionId=${encodeURIComponent(
              activeSessionId
            )}&token=${encodeURIComponent(inviteToken)}`;
          }
        }
      }
      if (!url) {
        setErrorMessage("No invitation link is available for this session. Start a new session to create one.");
        return;
      }
      await navigator.clipboard.writeText(url);
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 3500);
    } catch {
      setErrorMessage("Failed to copy the invitation link.");
    }
  };

  /** End the session: revoke the invitation and tear down the room. */
  const handleEndSession = async () => {
    const sid = activeSessionId;
    const tok = activeSessionToken;
    disconnectRoom();
    setCallEnded(true);
    setProspectTranscripts([]);
    setCurrentRecommendation(null);
    setActiveSessionId(null);
    setActiveSessionToken(null);
    if (sid && tok) {
      try {
        await fetch(`/api/sessions/${encodeURIComponent(sid)}`, {
          method: "DELETE",
          headers: { "x-session-token": tok },
        });
      } catch {
        /* best effort: the session may already have expired */
      }
    }
    onEnded?.();
  };

  const isConnected = connectionState === ConnectionState.Connected;
  const prospectParticipant = participants.find(
    (p) => !p.isLocal && p.identity.toLowerCase().startsWith("prospect")
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-brand" />
            <h2 className="text-lg font-semibold text-ink">Live Sales Room</h2>
          </div>
          <p className="mt-1 text-[13px] text-ink-soft">
            Audio-only room with live transcription and private, approval-gated AI guidance.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[12px] font-semibold ${
              isConnected
                ? isSimulatedMode
                  ? "border-warn/35 bg-warn/10 text-warn"
                  : "border-positive/35 bg-positive/10 text-positive"
                : isConnecting
                  ? "border-warn/35 bg-warn/10 text-warn"
                  : "border-line-strong bg-surface-2 text-ink-soft"
            }`}
          >
            <span
              className={`relative inline-block h-2 w-2 rounded-full ${
                isConnected && !isSimulatedMode
                  ? "bg-positive lbv-live-dot"
                  : isConnected || isConnecting
                    ? "bg-warn"
                    : "bg-ink-mute"
              }`}
            />
            {isSimulatedMode && isConnected
              ? "Simulated (LiveKit not configured)"
              : connectionLabel(connectionState)}
          </span>
          <button
            type="button"
            onClick={checkServerConfiguration}
            title="Refresh LiveKit configuration check"
            aria-label="Refresh LiveKit configuration check"
            className="rounded-lg border border-line p-2 text-ink-soft hover:bg-surface-2 hover:text-ink cursor-pointer"
          >
            <RefreshCw className={`h-4 w-4 ${checkingConfig ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {!checkingConfig && serverConfig && !serverConfig.configured && (
        <div className="flex items-start gap-3 rounded-lg border border-warn/35 bg-warn/10 px-4 py-3 text-[13px] text-warn">
          <Server className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">LiveKit Cloud credentials are not configured</p>
            <p className="mt-1 text-ink-soft">
              Live audio and transcription stay unavailable until the Worker has{" "}
              <code className="font-mono">LIVEKIT_URL</code>, <code className="font-mono">LIVEKIT_API_KEY</code> and{" "}
              <code className="font-mono">LIVEKIT_API_SECRET</code>.
            </p>
          </div>
        </div>
      )}

      {errorMessage && (
        <div className="flex items-start gap-3 rounded-lg border border-danger/35 bg-danger/10 px-4 py-3 text-[13px] text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Main column */}
        <div className="space-y-5 lg:col-span-8">
          {(currentRecommendation || isProcessingTranscript) && (
            <div className="rounded-xl border border-brand/40 bg-brand-tint/70 p-5">
              <div className="mb-3 flex items-center justify-between gap-3 border-b border-brand/20 pb-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-brand" />
                  <span className="text-[12px] font-semibold uppercase tracking-wider text-brand">
                    Private AI guidance
                  </span>
                </div>
                {currentRecommendation && (
                  <span
                    className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${
                      currentRecommendation.status === "BLOCKED"
                        ? "border-danger/40 bg-danger/15 text-danger"
                        : currentRecommendation.status === "RECOVERY_REQUIRED"
                          ? "border-warn/40 bg-warn/15 text-warn"
                          : "border-positive/40 bg-positive/15 text-positive"
                    }`}
                  >
                    {currentRecommendation.status === "BLOCKED"
                      ? "BLOCKED — SAFE FALLBACK"
                      : currentRecommendation.status === "RECOVERY_REQUIRED"
                        ? "RECOVERY REQUIRED"
                        : "APPROVED"}
                  </span>
                )}
              </div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-mute">Say this next</p>
              <div className="mt-1.5 rounded-lg border border-line bg-canvas/70 p-4 text-[15px] font-medium leading-relaxed text-ink">
                {isProcessingTranscript && !currentRecommendation ? (
                  <span className="flex items-center gap-2 text-[13px] text-ink-soft">
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    Analyzing the prospect's statement through the compliance gate…
                  </span>
                ) : (
                  currentRecommendation?.statement
                )}
              </div>
              <p className="mt-2 text-[11px] text-ink-mute">
                Visible only to you. Never published to the prospect's room.
              </p>
            </div>
          )}

          {/* Live transcript (prospect-only, never sent to the prospect) */}
          <div className="rounded-xl border border-line bg-surface/80">
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <div className="flex items-center gap-2">
                <Volume2 className="h-4 w-4 text-brand" />
                <h3 className="text-sm font-semibold text-ink">Live transcript</h3>
              </div>
              <span className="font-mono text-[11px] text-ink-mute">{prospectTranscripts.length} segments</span>
            </div>
            <div className="max-h-[320px] min-h-[160px] space-y-2 overflow-y-auto px-5 py-4">
              {prospectTranscripts.length === 0 ? (
                <p className="py-8 text-center text-[13px] text-ink-mute">
                  Waiting for the prospect to speak. Final transcript segments appear here as they are produced.
                </p>
              ) : (
                prospectTranscripts.map((line, index) => (
                  <div key={`${line.timestamp}-${index}`} className="rounded-lg border border-line bg-surface-2/50 px-3 py-2">
                    <p className="text-[13px] text-ink">{line.text}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-ink-mute">
                      {new Date(line.timestamp).toLocaleTimeString()}
                    </p>
                  </div>
                ))
              )}
              <div ref={transcriptEndRef} />
            </div>
          </div>

        </div>

        {/* Side column: controls and status stay visible next to the transcript */}
        <div className="space-y-5 lg:col-span-4">
          <div className="rounded-xl border border-line bg-surface/80">
            <div className="border-b border-line px-5 py-4">
              <h3 className="text-sm font-semibold text-ink">Call controls</h3>
              <p className="mt-0.5 text-[12px] text-ink-mute">Connected as the salesperson in this session.</p>
            </div>
            <div className="space-y-3 px-5 py-4">
              <button
                type="button"
                onClick={handleToggleMic}
                aria-pressed={!isMicEnabled}
                className={`flex w-full items-center justify-between rounded-lg border px-4 py-3 text-[13px] font-semibold transition-colors cursor-pointer ${
                  isMicEnabled
                    ? "border-line-strong bg-surface-2 text-ink hover:bg-surface-3"
                    : "border-danger/40 bg-danger/15 text-danger"
                }`}
              >
                <span className="flex items-center gap-2">
                  {isMicEnabled ? <Mic className="h-4 w-4 text-positive" /> : <MicOff className="h-4 w-4" />}
                  {isMicEnabled ? "Microphone on" : "Microphone muted"}
                </span>
                <span className="text-[11px] font-normal text-ink-mute">
                  Tap to {isMicEnabled ? "mute" : "unmute"}
                </span>
              </button>

              {!isConnected ? (
                <button
                  type="button"
                  onClick={handleJoinRoom}
                  disabled={isConnecting}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-positive bg-positive px-4 py-3 text-[13px] font-semibold text-[#05271a] transition-colors hover:brightness-110 disabled:opacity-50 cursor-pointer"
                >
                  <PhoneCall className="h-4 w-4" />
                  {isConnecting ? "Connecting…" : callEnded ? "Rejoin room" : "Join room"}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleLeaveRoom}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface-2 px-4 py-3 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-3 cursor-pointer"
                  >
                    <PhoneOff className="h-4 w-4" />
                    Leave room
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleEndSession()}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-danger bg-danger px-4 py-3 text-[13px] font-semibold text-[#2a0b12] transition-colors hover:brightness-110 cursor-pointer"
                    title="End the session and revoke the prospect invitation link"
                  >
                    <PhoneOff className="h-4 w-4" />
                    End session
                  </button>
                </>
              )}
              <p className="text-[11px] text-ink-mute">
                “Leave room” keeps the session and invitation active. “End session” revokes the invitation.
              </p>
            </div>
          </div>


          <div className="rounded-xl border border-line bg-surface/80">
            <div className="border-b border-line px-5 py-4">
              <h3 className="text-sm font-semibold text-ink">Prospect connection</h3>
            </div>
            <div className="px-5 py-4">
              {prospectParticipant ? (
                <div className="flex items-center gap-3">
                  <span className="relative inline-block h-2 w-2 rounded-full bg-positive lbv-live-dot" />
                  <div>
                    <p className="text-[13px] font-medium text-ink">
                      {prospectParticipant.isSpeaking ? "Prospect is speaking" : "Prospect connected"}
                    </p>
                    <p className="text-[12px] text-ink-mute">
                      Microphone {prospectParticipant.isAudioEnabled ? "on" : "muted"}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 text-[13px] text-ink-soft">
                  <span className="inline-block h-2 w-2 rounded-full bg-warn" />
                  Waiting for the prospect to join…
                </div>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-line bg-surface/80">
            <div className="border-b border-line px-5 py-4">
              <h3 className="text-sm font-semibold text-ink">Session</h3>
            </div>
            <div className="space-y-2 px-5 py-4 font-mono text-[11px]">
              <div className="flex justify-between gap-3">
                <span className="text-ink-mute">Session</span>
                <span className="truncate text-ink-soft">{activeSessionId || "—"}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-ink-mute">Room</span>
                <span className="truncate text-ink-soft">{roomName || "—"}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-ink-mute">Service</span>
                <span className="truncate text-ink-soft">{activeProductId}</span>
              </div>
            </div>
            <div className="border-t border-line px-5 py-4">
              <button
                type="button"
                onClick={() => void handleCopyInviteLink()}
                className={`flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-[12px] font-semibold transition-colors cursor-pointer ${
                  inviteCopied
                    ? "border-positive/40 bg-positive/15 text-positive"
                    : "border-line-strong bg-surface-2 text-ink-soft hover:text-ink"
                }`}
              >
                <Shield className="h-3.5 w-3.5" />
                {inviteCopied ? "Invitation link copied" : "Copy prospect invitation link"}
              </button>
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}

