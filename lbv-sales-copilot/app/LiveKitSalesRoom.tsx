import React, { useState, useEffect, useRef } from "react";
import {
  Room,
  RoomEvent,
  Track,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  LocalParticipant,
  ConnectionState,
  TrackPublication,
} from "livekit-client";
import {
  Radio,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Users,
  Shield,
  AlertCircle,
  CheckCircle2,
  Volume2,
  VolumeX,
  RefreshCw,
  Sparkles,
  Info,
  Server,
  KeyRound
} from "lucide-react";

interface ParticipantAudioState {
  identity: string;
  name?: string;
  isLocal: boolean;
  isSpeaking: boolean;
  isAudioEnabled: boolean;
  audioTrack?: any;
}

export interface LiveKitSalesRoomProps {
  sessionId?: string | null;
  sessionToken?: string | null;
  productId?: string;
}

export default function LiveKitSalesRoom({
  sessionId: propSessionId,
  sessionToken: propSessionToken,
  productId: propProductId = "shopify-conversion-pilot"
}: LiveKitSalesRoomProps = {}) {
  const [roomName, setRoomName] = useState("auto-derived-from-session");
  const [identity, setIdentity] = useState<"prospect" | "salesperson">("prospect");
  const [displayName, setDisplayName] = useState("");
  
  // Session tracking
  const [activeSessionId, setActiveSessionId] = useState<string | null>(propSessionId || null);
  const [activeSessionToken, setActiveSessionToken] = useState<string | null>(propSessionToken || null);
  const [activeProductId, setActiveProductId] = useState<string>(propProductId);
  const [isSimulatedMode, setIsSimulatedMode] = useState<boolean>(false);
  const [inviteCopied, setInviteCopied] = useState<boolean>(false);
  const [showManualSession, setShowManualSession] = useState<boolean>(false);
  const [manualSessionIdInput, setManualSessionIdInput] = useState<string>("");
  const [manualSessionTokenInput, setManualSessionTokenInput] = useState<string>("");

  // Sync prop changes
  useEffect(() => {
    if (propSessionId) setActiveSessionId(propSessionId);
    if (propSessionToken) setActiveSessionToken(propSessionToken);
    if (propProductId) setActiveProductId(propProductId);
  }, [propSessionId, propSessionToken, propProductId]);

  // Read URL params on mount to support instant 2-browser test links
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const qSessionId = params.get("sessionId");
      const qSessionToken = params.get("sessionToken");
      const qProductId = params.get("productId");
      const qRole = params.get("role");
      if (qSessionId) {
        setActiveSessionId(qSessionId);
        setManualSessionIdInput(qSessionId);
      }
      if (qSessionToken) {
        setActiveSessionToken(qSessionToken);
        setManualSessionTokenInput(qSessionToken);
      }
      if (qProductId) setActiveProductId(qProductId);
      if (qRole === "salesperson" || qRole === "prospect") {
        setIdentity(qRole);
      } else if (qSessionId) {
        // When joining via an existing invite link, default to salesperson
        setIdentity("salesperson");
      }
    }
  }, []);

  // Connection states
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [isConnecting, setIsConnecting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isMicEnabled, setIsMicEnabled] = useState(true);
  const [participants, setParticipants] = useState<ParticipantAudioState[]>([]);
  const [audioPermissionGranted, setAudioPermissionGranted] = useState<boolean | null>(null);
  
  // LiveKit server configuration check state
  const [serverConfig, setServerConfig] = useState<{
    configured: boolean;
    serverUrl: string | null;
    hasApiKey: boolean;
    hasApiSecret: boolean;
  } | null>(null);
  const [checkingConfig, setCheckingConfig] = useState(true);

  // Realtime "SAY THIS NEXT" recommendation state
  const [currentRecommendation, setCurrentRecommendation] = useState<{
    statement: string;
    status: "APPROVED" | "RECOVERY_REQUIRED" | "BLOCKED";
    timestamp: number;
    toolsUsed?: any[];
  } | null>(null);
  const [isProcessingTranscript, setIsProcessingTranscript] = useState<boolean>(false);
  const processedSegmentIdsRef = useRef<Set<string>>(new Set());

  const roomRef = useRef<Room | null>(null);
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  // Check server configuration on load
  useEffect(() => {
    checkServerConfiguration();
    return () => {
      disconnectRoom();
    };
  }, []);

  const checkServerConfiguration = async () => {
    setCheckingConfig(true);
    try {
      const res = await fetch("/api/livekit/status");
      if (res.ok) {
        const data = await res.json();
        setServerConfig(data);
      } else {
        setServerConfig({
          configured: false,
          serverUrl: null,
          hasApiKey: false,
          hasApiSecret: false
        });
      }
    } catch (e) {
      setServerConfig({
        configured: false,
        serverUrl: null,
        hasApiKey: false,
        hasApiSecret: false
      });
    } finally {
      setCheckingConfig(false);
    }
  };

  const updateParticipantsList = (room: Room) => {
    const list: ParticipantAudioState[] = [];

    // Local participant
    if (room.localParticipant) {
      const localMicTrack = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      list.push({
        identity: room.localParticipant.identity,
        name: room.localParticipant.name || room.localParticipant.identity,
        isLocal: true,
        isSpeaking: room.localParticipant.isSpeaking,
        isAudioEnabled: localMicTrack ? !localMicTrack.isMuted : isMicEnabled,
      });
    }

    // Remote participants
    room.remoteParticipants.forEach((p) => {
      const micPub = p.getTrackPublication(Track.Source.Microphone);
      const isMuted = micPub ? micPub.isMuted : true;
      list.push({
        identity: p.identity,
        name: p.name || p.identity,
        isLocal: false,
        isSpeaking: p.isSpeaking,
        isAudioEnabled: !isMuted,
        audioTrack: micPub?.audioTrack,
      });
    });

    setParticipants(list);
  };

  const handleJoinRoom = async () => {
    setErrorMessage(null);
    setIsConnecting(true);

    try {
      let currentSessionId = activeSessionId;
      let currentSessionToken = activeSessionToken;

      // Ensure an authorized session exists before requesting a LiveKit token
      if (!currentSessionId || !currentSessionToken) {
        const sessRes = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId: activeProductId })
        });
        if (!sessRes.ok) {
          const sessErr = await sessRes.json();
          throw new Error(sessErr.error || "Failed to create sales session.");
        }
        const sessData = await sessRes.json();
        currentSessionId = sessData.sessionId;
        currentSessionToken = sessData.sessionToken;
        setActiveSessionId(sessData.sessionId);
        setActiveSessionToken(sessData.sessionToken);
        if (sessData.roomName) setRoomName(sessData.roomName);
      }

      // 1. Fetch token from our hardened server endpoint
      const effectiveName = displayName.trim() || (identity === "prospect" ? "Prospect User" : "Sales Representative");
      const res = await fetch("/api/livekit/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(currentSessionToken ? { "x-session-token": currentSessionToken } : {})
        },
        body: JSON.stringify({
          sessionId: currentSessionId,
          sessionToken: currentSessionToken,
          productId: activeProductId,
          identity,
          name: effectiveName
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || errData.error || `Server returned ${res.status}`);
      }

      const { token, serverUrl, roomName: serverRoom, mode } = await res.json();
      if (serverRoom) setRoomName(serverRoom);

      // Handle simulated mode safely
      if (mode === "simulated") {
        setIsSimulatedMode(true);
        setConnectionState(ConnectionState.Connected);
        setIsConnecting(false);
        setParticipants([
          {
            identity,
            name: effectiveName,
            isLocal: true,
            isSpeaking: false,
            isAudioEnabled: isMicEnabled
          },
          {
            identity: identity === "prospect" ? "salesperson" : "prospect",
            name: identity === "prospect" ? "Sales Representative (Simulated)" : "Store Owner (Simulated)",
            isLocal: false,
            isSpeaking: false,
            isAudioEnabled: true
          }
        ]);
        return;
      }

      // 2. Initialize LiveKit Room client for real cloud connection
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

      // Event Handlers
      room
        .on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
          setConnectionState(state);
          if (state === ConnectionState.Connected) {
            setIsConnecting(false);
          } else if (state === ConnectionState.Disconnected) {
            setIsConnecting(false);
            setParticipants([]);
          }
        })
        .on(RoomEvent.ParticipantConnected, () => {
          updateParticipantsList(room);
        })
        .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
          const el = audioElementsRef.current.get(participant.identity);
          if (el) {
            el.remove();
            audioElementsRef.current.delete(participant.identity);
          }
          updateParticipantsList(room);
        })
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          if (track.kind === Track.Kind.Audio) {
            const audioElement = track.attach();
            audioElementsRef.current.set(participant.identity, audioElement);
          }
          updateParticipantsList(room);
        })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          if (track.kind === Track.Kind.Audio) {
            track.detach();
            const el = audioElementsRef.current.get(participant.identity);
            if (el) {
              el.remove();
              audioElementsRef.current.delete(participant.identity);
            }
          }
          updateParticipantsList(room);
        })
        .on(RoomEvent.ActiveSpeakersChanged, () => {
          updateParticipantsList(room);
        })
        .on(RoomEvent.TrackMuted, () => {
          updateParticipantsList(room);
        })
        .on(RoomEvent.TrackUnmuted, () => {
          updateParticipantsList(room);
        })
        .on(RoomEvent.Disconnected, () => {
          setConnectionState(ConnectionState.Disconnected);
          setParticipants([]);
        });

      // Wire RoomEvent.TranscriptionReceived to convert prospect speech transcripts to recommendations
      if ((RoomEvent as any).TranscriptionReceived) {
        room.on((RoomEvent as any).TranscriptionReceived, async (transcriptions: any[], participant?: RemoteParticipant | LocalParticipant) => {
          if (!transcriptions || transcriptions.length === 0) return;
          for (const publication of transcriptions) {
            const isFinal = publication.isFinal ?? publication.final ?? true;
            const text = publication.text || publication.transcript || "";
            const segmentId = publication.id || publication.segmentId || `${text}_${publication.firstReceivedTime || Date.now()}`;
            const speakerIdentity = participant?.identity || publication.participantIdentity || "prospect";

            // Process only final prospect speech segments and deduplicate
            if (isFinal && text.trim().length > 0 && !speakerIdentity.includes("salesperson") && !speakerIdentity.includes("lbv-ai")) {
              if (processedSegmentIdsRef.current.has(segmentId)) continue;
              processedSegmentIdsRef.current.add(segmentId);

              setIsProcessingTranscript(true);
              try {
                const transcriptRes = await fetch("/api/livekit/transcript", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    ...(currentSessionToken ? { "x-session-token": currentSessionToken } : {})
                  },
                  body: JSON.stringify({
                    sessionId: currentSessionId,
                    sessionToken: currentSessionToken,
                    text: text.trim(),
                    isFinal: true,
                    speaker: "prospect"
                  })
                });

                if (transcriptRes.ok) {
                  const data = await transcriptRes.json();
                  if (data.recommendation) {
                    setCurrentRecommendation({
                      statement: data.recommendation.statement,
                      status: data.recommendation.status,
                      timestamp: Date.now(),
                      toolsUsed: data.recommendation.toolsUsed
                    });
                  }
                }
              } catch (txErr) {
                console.error("Failed to process LiveKit transcript:", txErr);
              } finally {
                setIsProcessingTranscript(false);
              }
            }
          }
        });
      }

      // 3. Connect to LiveKit Room
      await room.connect(serverUrl, token);

      // 4. Start audio playback context to satisfy browser autoplay policies
      try {
        await room.startAudio();
      } catch (audioErr) {
        console.warn("Audio autoplay policy restriction on startAudio:", audioErr);
      }

      // 5. Attach any existing subscribed remote audio tracks (in case other participant joined first)
      room.remoteParticipants.forEach((p) => {
        p.trackPublications.forEach((pub) => {
          if (pub.track && pub.track.kind === Track.Kind.Audio && !audioElementsRef.current.has(p.identity)) {
            const el = pub.track.attach();
            el.autoplay = true;
            audioElementsRef.current.set(p.identity, el);
          }
        });
      });

      // 6. Publish local microphone track
      try {
        await room.localParticipant.setMicrophoneEnabled(isMicEnabled);
        setAudioPermissionGranted(true);
      } catch (micErr: any) {
        console.warn("Microphone permission was denied or failed:", micErr);
        setAudioPermissionGranted(false);
        setErrorMessage(
          "Microphone permission was denied or device is unavailable. You are connected to the room as a listener, but your microphone audio will not be broadcast."
        );
      }

      updateParticipantsList(room);

    } catch (err: any) {
      console.error("LiveKit connection error:", err);
      let userFriendlyMessage = err.message || "Failed to connect to LiveKit room.";
      if (userFriendlyMessage.includes("UNAUTHORIZED") || userFriendlyMessage.includes("Unauthorized")) {
        userFriendlyMessage = "Unauthorized session: The provided session token is invalid or does not match this session.";
      } else if (userFriendlyMessage.includes("SESSION_NOT_FOUND") || userFriendlyMessage.includes("not found")) {
        userFriendlyMessage = "Session expired or not found. Please establish a new sales session.";
      } else if (userFriendlyMessage.includes("MISMATCHED_SESSION_PRODUCT")) {
        userFriendlyMessage = "Product mismatch: This session belongs to another product and cannot join this room.";
      } else if (userFriendlyMessage.includes("network") || userFriendlyMessage.includes("WebSocket") || userFriendlyMessage.includes("failed to connect")) {
        userFriendlyMessage = "Network connection failed. Unable to connect to LiveKit Cloud. Please check your connection.";
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
      setParticipants((prev) =>
        prev.map((p) => (p.isLocal ? { ...p, isAudioEnabled: nextState } : p))
      );
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
      updateParticipantsList(roomRef.current);
    } catch (e: any) {
      console.error("Failed to toggle microphone:", e);
      setErrorMessage("Could not toggle microphone: " + e.message);
    }
  };

  const disconnectRoom = () => {
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
  };

  const handleCopyInviteLink = async () => {
    try {
      let curId = activeSessionId;
      let curToken = activeSessionToken;
      if (!curId || !curToken) {
        const sessRes = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId: activeProductId })
        });
        if (sessRes.ok) {
          const sessData = await sessRes.json();
          curId = sessData.sessionId;
          curToken = sessData.sessionToken;
          setActiveSessionId(curId);
          setActiveSessionToken(curToken);
          if (sessData.roomName) setRoomName(sessData.roomName);
        }
      }
      if (curId && curToken) {
        const inviteUrl = `${window.location.origin}${window.location.pathname}?tab=livekit&sessionId=${encodeURIComponent(
          curId
        )}&sessionToken=${encodeURIComponent(curToken)}&productId=${encodeURIComponent(
          activeProductId
        )}&role=salesperson`;
        await navigator.clipboard.writeText(inviteUrl);
        setInviteCopied(true);
        setTimeout(() => setInviteCopied(false), 3500);
      }
    } catch (e: any) {
      console.error("Failed to copy invite link:", e);
    }
  };

  const handleCreateNewSession = async () => {
    if (isConnected || isConnecting) return;
    try {
      const sessRes = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: activeProductId })
      });
      if (sessRes.ok) {
        const sessData = await sessRes.json();
        setActiveSessionId(sessData.sessionId);
        setActiveSessionToken(sessData.sessionToken);
        setManualSessionIdInput(sessData.sessionId);
        setManualSessionTokenInput(sessData.sessionToken);
        if (sessData.roomName) setRoomName(sessData.roomName);
        setErrorMessage(null);
      }
    } catch (e: any) {
      console.error("Failed to create new session:", e);
    }
  };

  const handleApplyManualCredentials = () => {
    if (manualSessionIdInput.trim() && manualSessionTokenInput.trim()) {
      setActiveSessionId(manualSessionIdInput.trim());
      setActiveSessionToken(manualSessionTokenInput.trim());
      setRoomName(`room_${activeProductId}_${manualSessionIdInput.trim()}`);
      setShowManualSession(false);
      setErrorMessage(null);
    }
  };

  const isConnected = connectionState === ConnectionState.Connected;

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-2xl backdrop-blur-sm">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 pb-6 border-b border-slate-800/80">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5 animate-pulse text-emerald-400" />
              Stage 3.1 LiveKit Realtime Media Foundation
            </span>
            <span className="text-xs text-slate-400 font-mono">WebRTC Audio Channel</span>
          </div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            LiveKit Realtime Sales Room
          </h2>
          <p className="text-slate-400 text-xs mt-1">
            Prospect &amp; Salesperson bidirectional realtime audio room over LiveKit Cloud.
          </p>
        </div>

        {/* Connection Status Badge */}
        <div className="flex items-center gap-2 self-start md:self-auto">
          <div
            className={`px-3 py-1.5 rounded-xl border text-xs font-bold flex items-center gap-2 ${
              isConnected
                ? isSimulatedMode
                  ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-300"
                  : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                : isConnecting
                ? "bg-amber-500/10 border-amber-500/30 text-amber-400"
                : "bg-slate-800 border-slate-700 text-slate-400"
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isConnected
                  ? isSimulatedMode
                    ? "bg-indigo-400 animate-pulse"
                    : "bg-emerald-400 animate-ping"
                  : isConnecting
                  ? "bg-amber-400 animate-pulse"
                  : "bg-slate-500"
              }`}
            />
            {isConnected
              ? isSimulatedMode
                ? "Simulated Sandbox (No Cloud Connection)"
                : "LiveKit Cloud Active (WebRTC Audio)"
              : isConnecting
              ? "Connecting to LiveKit..."
              : connectionState === ConnectionState.Reconnecting
              ? "Reconnecting..."
              : "Disconnected"}
          </div>

          <button
            onClick={checkServerConfiguration}
            title="Refresh LiveKit server config check"
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg border border-slate-800 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${checkingConfig ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Cloud Configuration Notice */}
      {!checkingConfig && serverConfig && !serverConfig.configured && (
        <div className="mt-5 bg-amber-500/10 border border-amber-500/25 rounded-xl p-4 text-xs text-amber-300 flex flex-col md:flex-row gap-3 items-start justify-between">
          <div className="flex gap-3 items-start">
            <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-amber-200 mb-1">
                LiveKit Cloud Credentials Not Detected (Configuration Mode)
              </p>
              <p className="text-slate-300 text-xs leading-relaxed">
                The realtime token endpoint is active, but requires LiveKit Cloud environment variables:
              </p>
              <div className="mt-2 flex flex-wrap gap-2 font-mono text-[11px]">
                <span className={`px-2 py-0.5 rounded ${serverConfig.serverUrl ? "bg-emerald-950 text-emerald-300 border border-emerald-800" : "bg-slate-800 text-slate-400 border border-slate-700"}`}>
                  LIVEKIT_URL {serverConfig.serverUrl ? "✓" : "(missing)"}
                </span>
                <span className={`px-2 py-0.5 rounded ${serverConfig.hasApiKey ? "bg-emerald-950 text-emerald-300 border border-emerald-800" : "bg-slate-800 text-slate-400 border border-slate-700"}`}>
                  LIVEKIT_API_KEY {serverConfig.hasApiKey ? "✓" : "(missing)"}
                </span>
                <span className={`px-2 py-0.5 rounded ${serverConfig.hasApiSecret ? "bg-emerald-950 text-emerald-300 border border-emerald-800" : "bg-slate-800 text-slate-400 border border-slate-700"}`}>
                  LIVEKIT_API_SECRET {serverConfig.hasApiSecret ? "✓" : "(missing)"}
                </span>
              </div>
            </div>
          </div>
          <span className="text-[10px] text-slate-400 bg-slate-950/60 px-2.5 py-1 rounded-md border border-slate-800 shrink-0">
            Stage 3.1 Ready
          </span>
        </div>
      )}

      {/* Error Alert */}
      {errorMessage && (
        <div className="mt-4 bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 text-xs text-rose-300 flex gap-2.5 items-center">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Live "SAY THIS NEXT" Silent Copilot Banner */}
      {(currentRecommendation || isProcessingTranscript) && (
        <div className="mt-5 bg-gradient-to-r from-indigo-950/80 via-slate-900 to-purple-950/80 border border-indigo-500/40 rounded-2xl p-5 shadow-2xl animate-fadeIn">
          <div className="flex items-center justify-between mb-3 border-b border-indigo-500/20 pb-2.5">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-400" />
              <span className="text-xs font-bold text-indigo-300 uppercase tracking-wider">
                Silent Sales Copilot Guidance
              </span>
            </div>
            {currentRecommendation && (
              <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono border ${
                currentRecommendation.status === "BLOCKED"
                  ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
                  : "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
              }`}>
                {currentRecommendation.status === "BLOCKED" ? "BLOCKED (SAFE FALLBACK)" : "APPROVED"}
              </span>
            )}
          </div>

          <div className="space-y-1">
            <span className="text-[10px] uppercase tracking-widest text-slate-400 font-extrabold block">
              SAY THIS NEXT
            </span>
            <div className="text-base font-bold text-slate-100 bg-slate-950/90 border border-slate-800 p-4 rounded-xl leading-relaxed">
              {isProcessingTranscript ? (
                <span className="text-indigo-300 flex items-center gap-2 animate-pulse text-sm">
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Analyzing prospect utterance and evaluating deterministic compliance gate...
                </span>
              ) : (
                currentRecommendation?.statement
              )}
            </div>
          </div>
        </div>
      )}

      {/* Room Controls & Setup Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-6">
        {/* Left Column: Room Setup & Identity */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-4 space-y-4">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
              <Users className="w-3.5 h-3.5 text-indigo-400" />
              Room &amp; Participant Setup
            </h3>

            {/* Authorized Session & Room Display */}
            <div className="space-y-2">
              <div className="flex justify-between items-center mb-1">
                <label className="text-xs font-medium text-slate-400">
                  Authorized Session &amp; Room
                </label>
                {activeSessionId && (
                  <span className="text-[10px] text-emerald-400 font-mono">
                    {activeProductId}
                  </span>
                )}
              </div>
              <div className="bg-slate-900 border border-slate-700/80 rounded-lg p-2.5 space-y-1.5 font-mono text-[11px]">
                <div className="text-slate-400 flex justify-between items-center">
                  <span>Session:</span>
                  <span className="text-slate-200 truncate max-w-[200px]">
                    {activeSessionId || "(Auto-generated on join)"}
                  </span>
                </div>
                <div className="text-slate-400 flex justify-between items-center">
                  <span>Room:</span>
                  <span className="text-indigo-300 truncate max-w-[200px]">{roomName}</span>
                </div>
              </div>

              {/* 2-Browser Test Invite Link & Session Controls */}
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleCopyInviteLink}
                  className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
                    inviteCopied
                      ? "bg-emerald-600/20 text-emerald-300 border-emerald-500/40"
                      : "bg-slate-900 hover:bg-slate-800 text-slate-300 border-slate-700 hover:text-white"
                  }`}
                  title="Copy direct invite link with session token for second browser"
                >
                  <Sparkles className="w-3 h-3 text-indigo-400" />
                  {inviteCopied ? "Invite Link Copied!" : "Copy 2-Browser Invite Link"}
                </button>

                <button
                  type="button"
                  disabled={isConnected || isConnecting}
                  onClick={handleCreateNewSession}
                  className="px-2.5 py-1.5 rounded-lg border border-slate-700 hover:border-slate-600 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 text-[11px] font-semibold flex items-center gap-1 transition-colors disabled:opacity-50 cursor-pointer"
                  title="Mint a fresh session"
                >
                  <RefreshCw className="w-3 h-3" />
                  New Session
                </button>

                <button
                  type="button"
                  disabled={isConnected || isConnecting}
                  onClick={() => setShowManualSession(!showManualSession)}
                  className="px-2.5 py-1.5 rounded-lg border border-slate-800 text-slate-400 hover:text-slate-300 text-[11px] font-semibold transition-colors disabled:opacity-50 cursor-pointer"
                >
                  {showManualSession ? "Hide Manual" : "Manual Join"}
                </button>
              </div>

              {/* Manual Session Credentials Inputs */}
              {showManualSession && (
                <div className="mt-2 p-3 bg-slate-900/90 border border-slate-700 rounded-lg space-y-2 text-xs">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Session ID:</label>
                    <input
                      type="text"
                      disabled={isConnected || isConnecting}
                      value={manualSessionIdInput}
                      onChange={(e) => setManualSessionIdInput(e.target.value)}
                      placeholder="sess_..."
                      className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Session Authorization Token:</label>
                    <input
                      type="password"
                      disabled={isConnected || isConnecting}
                      value={manualSessionTokenInput}
                      onChange={(e) => setManualSessionTokenInput(e.target.value)}
                      placeholder="stok_..."
                      className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 font-mono"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={isConnected || isConnecting || !manualSessionIdInput.trim() || !manualSessionTokenInput.trim()}
                    onClick={handleApplyManualCredentials}
                    className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-1.5 px-3 rounded text-xs transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    Apply Session Credentials
                  </button>
                </div>
              )}

              {isSimulatedMode && (
                <div className="mt-2 bg-indigo-500/10 border border-indigo-500/30 rounded-lg p-2 text-indigo-300 text-xs flex items-center gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  <span>Simulated realtime session active (Hardened sandbox mode).</span>
                </div>
              )}
            </div>

            {/* Role / Identity Selector */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                My Participant Identity
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isConnected || isConnecting}
                  onClick={() => setIdentity("prospect")}
                  className={`px-3 py-2.5 rounded-lg border text-xs font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer ${
                    identity === "prospect"
                      ? "bg-indigo-600/20 border-indigo-500 text-indigo-300 shadow-sm"
                      : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200"
                  } disabled:opacity-50`}
                >
                  <span className="w-2 h-2 rounded-full bg-cyan-400" />
                  prospect
                </button>
                <button
                  type="button"
                  disabled={isConnected || isConnecting}
                  onClick={() => setIdentity("salesperson")}
                  className={`px-3 py-2.5 rounded-lg border text-xs font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer ${
                    identity === "salesperson"
                      ? "bg-purple-600/20 border-purple-500 text-purple-300 shadow-sm"
                      : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200"
                  } disabled:opacity-50`}
                >
                  <span className="w-2 h-2 rounded-full bg-purple-400" />
                  salesperson
                </button>
              </div>

              {/* Reserved Identity Notice */}
              <div className="mt-2.5 bg-slate-900/70 border border-slate-800 rounded-lg p-2.5 flex items-start gap-2 text-[11px] text-slate-400">
                <Shield className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                <span>
                  <strong className="text-slate-300 font-mono">lbv-ai</strong> is strictly reserved as the silent AI observer participant for Stage 3.2.
                </span>
              </div>
            </div>

            {/* Display Name Input */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Display Name (Optional)
              </label>
              <input
                type="text"
                disabled={isConnected || isConnecting}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={identity === "prospect" ? "Prospect Store Owner" : "Sales Specialist"}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
              />
            </div>

            {/* Join / Leave Buttons */}
            <div className="pt-2 flex gap-2.5">
              {!isConnected ? (
                <button
                  type="button"
                  onClick={handleJoinRoom}
                  disabled={isConnecting}
                  className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 px-4 rounded-xl text-xs flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-950/40 cursor-pointer disabled:opacity-50"
                >
                  <PhoneCall className="w-4 h-4" />
                  {isConnecting ? "Connecting to LiveKit..." : "Join Sales Room"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={disconnectRoom}
                  className="flex-1 bg-rose-600 hover:bg-rose-500 text-white font-bold py-2.5 px-4 rounded-xl text-xs flex items-center justify-center gap-2 transition-all shadow-lg shadow-rose-950/40 cursor-pointer"
                >
                  <PhoneOff className="w-4 h-4" />
                  Leave Room
                </button>
              )}

              {/* Microphone Toggle */}
              <button
                type="button"
                onClick={handleToggleMic}
                className={`px-4 py-2.5 rounded-xl border text-xs font-bold flex items-center gap-2 transition-all cursor-pointer ${
                  isMicEnabled
                    ? "bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
                    : "bg-rose-500/20 text-rose-300 border-rose-500/40"
                }`}
                title={isMicEnabled ? "Mute Microphone" : "Unmute Microphone"}
              >
                {isMicEnabled ? (
                  <>
                    <Mic className="w-4 h-4 text-emerald-400" />
                    Mic On
                  </>
                ) : (
                  <>
                    <MicOff className="w-4 h-4 text-rose-400" />
                    Muted
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Right Column: Live Room State & Participants */}
        <div className="lg:col-span-7 space-y-4">
          <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-4 min-h-[300px] flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-center pb-3 border-b border-slate-800">
                <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
                  <Volume2 className="w-3.5 h-3.5 text-cyan-400" />
                  Active Room Audio Channels ({participants.length})
                </h3>
                <span className="text-[11px] font-mono text-slate-400">
                  Room: {roomName}
                </span>
              </div>

              {/* Participants Grid */}
              <div className="mt-4 space-y-2.5">
                {participants.length === 0 ? (
                  <div className="text-center py-10 text-slate-500 text-xs">
                    <Radio className="w-8 h-8 text-slate-700 mx-auto mb-2 opacity-50" />
                    <p className="font-semibold text-slate-400">Room is currently empty</p>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      Join from this browser and another browser tab to test bidirectional audio transmission.
                    </p>
                  </div>
                ) : (
                  participants.map((p) => (
                    <div
                      key={p.identity}
                      className={`p-3 rounded-xl border flex items-center justify-between transition-all ${
                        p.isSpeaking
                          ? "bg-emerald-500/10 border-emerald-500/40 ring-1 ring-emerald-500/30"
                          : "bg-slate-900/90 border-slate-800"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs ${
                            p.identity === "prospect"
                              ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                              : p.identity === "salesperson"
                              ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                              : "bg-slate-800 text-slate-300"
                          }`}
                        >
                          {p.identity === "prospect" ? "P" : p.identity === "salesperson" ? "S" : "AI"}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-slate-200">
                              {p.name}
                            </span>
                            {p.isLocal && (
                              <span className="text-[10px] bg-indigo-500/20 text-indigo-300 px-1.5 py-0.2 rounded font-semibold border border-indigo-500/30">
                                You
                              </span>
                            )}
                          </div>
                          <span className="text-[11px] text-slate-400 font-mono">
                            identity: {p.identity}
                          </span>
                        </div>
                      </div>

                      {/* Participant Audio Indicators */}
                      <div className="flex items-center gap-2">
                        {p.isSpeaking && (
                          <span className="text-[10px] bg-emerald-500/20 text-emerald-300 font-semibold px-2 py-0.5 rounded-full flex items-center gap-1 border border-emerald-500/30 animate-pulse">
                            <Volume2 className="w-3 h-3" />
                            Speaking
                          </span>
                        )}

                        <div
                          className={`p-1.5 rounded-lg ${
                            p.isAudioEnabled
                              ? "bg-emerald-500/15 text-emerald-400"
                              : "bg-rose-500/15 text-rose-400"
                          }`}
                          title={p.isAudioEnabled ? "Microphone active" : "Microphone muted"}
                        >
                          {p.isAudioEnabled ? (
                            <Mic className="w-3.5 h-3.5" />
                          ) : (
                            <MicOff className="w-3.5 h-3.5" />
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Architecture Footer Status */}
            <div className="mt-6 pt-3 border-t border-slate-800/80 flex flex-col md:flex-row justify-between items-start md:items-center text-[11px] text-slate-400 gap-2">
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Audio tracks automatically play through browser speakers.</span>
              </div>
              <div className="text-[10px] font-mono text-slate-500">
                LiveKit Cloud WebRTC
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
