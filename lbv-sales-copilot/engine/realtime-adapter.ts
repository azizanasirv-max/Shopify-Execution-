/**
 * LiveKit Realtime Adapter for Generic Sales Engine
 *
 * Integrates the generic engine with LiveKit Cloud.
 *
 * Requirements:
 * - Must support a silent copilot that displays text recommendations without publishing AI audio.
 * - Manages participant token generation and role grants.
 * - Reserved identity 'lbv-ai' for silent sales assistant.
 * - Translates incoming realtime events into GenericSalesEngine recommendations.
 * - Broadcasts recommendations as text/data payloads only (NO AI voice/audio track).
 */

import { AccessToken } from "livekit-server-sdk";
import { GenericSalesEngine } from "./generic-sales-engine.js";
import {
  RealtimeAdapterConfig,
  RealtimeCopilotMessage,
  SalesRecommendation
} from "./types.js";

export class LiveKitRealtimeAdapter {
  private engine: GenericSalesEngine;
  private serverUrl: string | null;
  private apiKey: string | null;
  private apiSecret: string | null;

  constructor(engine: GenericSalesEngine) {
    this.engine = engine;
    this.serverUrl = process.env.LIVEKIT_URL || null;
    this.apiKey = process.env.LIVEKIT_API_KEY || null;
    this.apiSecret = process.env.LIVEKIT_API_SECRET || null;
  }

  /**
   * Checks if LiveKit server environment variables are configured
   */
  public isConfigured(): boolean {
    return Boolean(
      this.serverUrl &&
      this.apiKey &&
      this.apiSecret &&
      !this.apiKey.includes("MY_") &&
      !this.apiSecret.includes("MY_")
    );
  }

  public getStatus() {
    return {
      configured: this.isConfigured(),
      serverUrl: this.serverUrl,
      hasApiKey: Boolean(this.apiKey && !this.apiKey.includes("MY_")),
      hasApiSecret: Boolean(this.apiSecret && !this.apiSecret.includes("MY_"))
    };
  }

  /**
   * Generates a short-lived token for human participants (prospect, salesperson)
   * or future silent AI copilot ('lbv-ai').
   */
  public async createParticipantToken(
    roomName: string,
    identity: string,
    displayName?: string
  ): Promise<{ token: string; serverUrl: string; roomName: string; identity: string; expiresIn: number }> {
    if (!this.isConfigured()) {
      throw new Error("LiveKit server credentials are not configured in environment.");
    }

    // Determine permissions: 'lbv-ai' is strictly a silent text observer that publishes NO audio
    const isAiCopilot = identity === "lbv-ai";

    const at = new AccessToken(this.apiKey!, this.apiSecret!, {
      identity,
      name: displayName || identity,
      ttl: "1h"
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      // The AI copilot is strictly silent and NEVER publishes audio tracks
      canPublish: !isAiCopilot,
      canPublishData: true, // Allowed to send data channel text recommendations
      canSubscribe: true
    });

    const token = await at.toJwt();

    return {
      token,
      serverUrl: this.serverUrl!,
      roomName,
      identity,
      expiresIn: 3600
    };
  }

  /**
   * Processes a live statement received in the sales room, runs it through
   * the GenericSalesEngine, and formats a silent recommendation payload.
   */
  public async handleLiveProspectUtterance(
    roomName: string,
    prospectUtterance: string
  ): Promise<RealtimeCopilotMessage> {
    const recommendation: SalesRecommendation = await this.engine.generateRecommendation(prospectUtterance);

    const message: RealtimeCopilotMessage = {
      type: "recommendation",
      recommendation,
      status: "ready",
      roomName,
      timestamp: Date.now()
    };

    return message;
  }
}
