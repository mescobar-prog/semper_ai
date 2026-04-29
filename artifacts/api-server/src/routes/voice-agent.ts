import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import {
  ensureAgentId,
  getSignedUrl,
  getVoiceId,
  isVoiceAgentConfigured,
  VoiceAgentApiError,
  VoiceAgentNotConfiguredError,
} from "../lib/elevenlabs";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.post("/voice-agent/session", requireAuth, async (_req, res) => {
  if (!isVoiceAgentConfigured()) {
    res.status(503).json({
      error:
        "Voice agent is not configured: ELEVENLABS_API_KEY is missing on the server.",
    });
    return;
  }
  try {
    const agentId = await ensureAgentId();
    const signedUrl = await getSignedUrl(agentId);
    res.json({
      agentId,
      signedUrl,
      voiceId: getVoiceId(),
    });
  } catch (err) {
    if (err instanceof VoiceAgentNotConfiguredError) {
      res.status(503).json({ error: err.message });
      return;
    }
    if (err instanceof VoiceAgentApiError) {
      // The HTTP status to the browser stays 502 (the failure is upstream,
      // not on this server), but we surface the original ElevenLabs
      // status code in the body so support / the operator can debug
      // (401 = bad API key, 403 = wrong workspace, 429 = rate limited,
      // 5xx = ElevenLabs outage). The error.message already redacts the
      // raw API key.
      logger.error({ err, status: err.status }, "ElevenLabs request failed");
      res.status(502).json({
        error: `Voice agent upstream error: ${err.message}`,
        upstreamStatus: err.status,
      });
      return;
    }
    logger.error({ err }, "Unexpected voice-agent session error");
    res.status(500).json({
      error: "Could not start a voice-agent session. Try again.",
    });
  }
});

export default router;
