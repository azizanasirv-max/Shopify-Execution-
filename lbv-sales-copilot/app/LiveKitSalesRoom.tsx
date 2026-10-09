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

export default function LiveKitSalesRoom() {
  const [roomName, setRoomName] = useState("lbv-sales-demo-01");
  const [identity, setIdentity] = useState<"prospect" | "salesperson">("prospect");
  const [displayName, setDisplayName] = useState("");
  
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
    if (!roomName.trim()) {
      setErrorMessage("Please enter a room name.");
      return;
    }

    setErrorMessage(null);
    setIsConnecting(true);

    try {
      // 1. Fetch short-lived token from our secure server endpoint
      const effectiveName = displayName.trim() || (identity === "prospect" ? "Prospect User" : "Sales Representative");
      const res = await fetch("/api/livekit/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomName: roomName.trim(),
          identity,
          name: effectiveName
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || errData.error || `Server returned ${res.status}`);
      }

      const { token, serverUrl } = await res.json();

      // 2. Initialize LiveKit Room client
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
          // Remove attached audio element if exists
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

      // 3. Connect to LiveKit Room
      await room.connect(serverUrl, token);

      // 4. Publish local microphone track
      try {
        await room.localParticipant.setMicrophoneEnabled(isMicEnabled);
        setAudioPermissionGranted(true);
      } catch (micErr: any) {
        console.warn("Microphone permission was denied or failed:", micErr);
        setAudioPermissionGranted(false);
      }

      updateParticipantsList(room);

    } catch (err: any) {
      console.error("LiveKit connection error:", err);
      setErrorMessage(err.message || "Failed to connect to LiveKit room.");
      setIsConnecting(false);
      setConnectionState(ConnectionState.Disconnected);
    }
  };

  const handleToggleMic = async () => {
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
    // Clean up all audio elements
    audioElementsRef.current.forEach((el) => el.remove());
    audioElementsRef.current.clear();
    setConnectionState(ConnectionState.Disconnected);
    setParticipants([]);
    setIsConnecting(false);
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
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                : isConnecting
                ? "bg-amber-500/10 border-amber-500/30 text-amber-400"
                : "bg-slate-800 border-slate-700 text-slate-400"
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isConnected
                  ? "bg-emerald-400 animate-ping"
                  : isConnecting
                  ? "bg-amber-400 animate-pulse"
                  : "bg-slate-500"
              }`}
            />
            Status:{" "}
            {connectionState === ConnectionState.Connected
              ? "Connected"
              : connectionState === ConnectionState.Connecting
              ? "Connecting..."
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

      {/* Room Controls & Setup Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-6">
        {/* Left Column: Room Setup & Identity */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-4 space-y-4">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
              <Users className="w-3.5 h-3.5 text-indigo-400" />
              Room &amp; Participant Setup
            </h3>

            {/* Room Name Input */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                LiveKit Room Name
              </label>
              <input
                type="text"
                disabled={isConnected || isConnecting}
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                placeholder="sales-room-demo"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 disabled:opacity-50 font-mono"
              />
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
