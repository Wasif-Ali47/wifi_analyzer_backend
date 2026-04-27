const mongoose = require("mongoose");
const OpenAI = require("openai");
const ChatSession = require("../models/chatModel");
const { NETWORK_ERROR, INVALID_ID, NOT_FOUND } = require("../messages/message");

// ── constants ──────────────────────────────────────────────────────────────

const CHAT_SYSTEM_PROMPT = `You are an expert WiFi networking assistant embedded in the WiFi Analyzer app.
Help users with:
- Understanding WiFi metrics (RSSI, signal strength in dBm, channels, frequency bands)
- Diagnosing connectivity issues, interference, and dead zones
- Optimizing WiFi performance, channel selection, and router placement
- Explaining security protocols (WPA3, WPA2, WPA, WEP, Open)
- Troubleshooting slow speeds, dropped connections, or high latency

Be concise, practical, and friendly. Use plain language unless the user clearly wants technical depth.
Limit responses to 3–5 short paragraphs unless a longer explanation is genuinely needed.`;

// ── helpers ────────────────────────────────────────────────────────────────

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

/** Derive a session title from the first user message (max 60 chars). */
function deriveTitle(content) {
  const trimmed = content.trim();
  return trimmed.length <= 60 ? trimmed : trimmed.slice(0, 57).trimEnd() + "...";
}

function getChatClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    const err = new Error("OPENAI_API_KEY is not configured");
    err.statusCode = 503;
    throw err;
  }
  return new OpenAI({ apiKey: key });
}

function getModel() {
  return (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
}

async function callOpenAI(messages) {
  let client;
  try {
    client = getChatClient();
  } catch (e) {
    throw e;
  }
  const completion = await client.chat.completions.create({
    model: getModel(),
    messages: [{ role: "system", content: CHAT_SYSTEM_PROMPT }, ...messages],
    temperature: 0.7,
    max_tokens: 1024,
  });
  return completion.choices?.[0]?.message?.content?.trim() || "";
}

// ── guest ──────────────────────────────────────────────────────────────────

/**
 * POST /api/chat/guest
 * Stateless: no auth, no history saved. Just calls AI and returns the reply.
 * Body: { messages: [{ role: "user"|"assistant", content: string }, ...] }
 */
async function handleGuestChat(req, res) {
  const { messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }

  const valid = ["user", "assistant"];
  for (const m of messages) {
    if (!valid.includes(m.role)) {
      return res.status(400).json({ error: `Invalid role "${m.role}"` });
    }
    if (typeof m.content !== "string" || !m.content.trim()) {
      return res.status(400).json({ error: "Each message must have non-empty content" });
    }
  }

  const payload = messages.map((m) => ({ role: m.role, content: m.content.trim() }));

  let reply;
  try {
    reply = await callOpenAI(payload);
  } catch (err) {
    if (err.statusCode === 503) return res.status(503).json({ error: err.message });
    const msg = err?.error?.message || err?.message || "OpenAI request failed";
    console.error("[chat guest]", msg);
    return res.status(502).json({ error: msg });
  }

  if (!reply) return res.status(502).json({ error: "Empty response from model" });
  return res.json({ reply });
}

// ── authenticated respond ──────────────────────────────────────────────────

/**
 * POST /api/chat/respond   (requires JWT auth)
 * Send a user message, get AI reply, and persist both to the session.
 * Creates a new session if sessionId is omitted.
 * Body: { content: string, sessionId?: string }
 * Returns: { reply, sessionId, sessionTitle }
 */
async function handleRespond(req, res) {
  const userId = req.authUser._id;
  const content =
    typeof req.body.content === "string" ? req.body.content.trim() : "";
  if (!content) return res.status(400).json({ error: "content is required" });

  const sessionId = req.body.sessionId;

  let session;
  try {
    if (sessionId) {
      if (!isValidId(sessionId)) return res.status(400).json({ error: INVALID_ID });
      session = await ChatSession.findOne({ _id: sessionId, userId });
      if (!session) return res.status(404).json({ error: NOT_FOUND });
    } else {
      session = await ChatSession.create({
        userId,
        title: deriveTitle(content),
        messages: [],
      });
    }
  } catch (err) {
    console.error("[chat respond] session fetch/create:", err);
    return res.status(500).json({ error: NETWORK_ERROR });
  }

  // Append user message
  session.messages.push({ role: "user", content });
  try {
    await session.save();
  } catch (err) {
    console.error("[chat respond] save user msg:", err);
    return res.status(500).json({ error: NETWORK_ERROR });
  }

  // Build OpenAI payload — cap at last 40 turns to stay within token limits
  const history = session.messages.slice(-40).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let reply;
  try {
    reply = await callOpenAI(history);
  } catch (err) {
    if (err.statusCode === 503) return res.status(503).json({ error: err.message });
    const msg = err?.error?.message || err?.message || "OpenAI request failed";
    console.error("[chat respond] openai:", msg);
    return res.status(502).json({ error: msg });
  }

  if (!reply) return res.status(502).json({ error: "Empty response from model" });

  // Append AI reply and persist
  session.messages.push({ role: "assistant", content: reply });
  try {
    await session.save();
  } catch (err) {
    console.error("[chat respond] save assistant msg:", err);
    // Reply was generated — still return it even if save failed
  }

  return res.json({
    reply,
    sessionId: session._id.toString(),
    sessionTitle: session.title,
  });
}

// ── session CRUD ───────────────────────────────────────────────────────────

/**
 * POST /api/chat/sessions
 * Create a new chat session, optionally seeded with a first message.
 * Body: { title?, firstMessage? }
 */
async function handleCreateSession(req, res) {
  const userId = req.authUser._id;
  const { title, firstMessage } = req.body;

  const messages = [];
  if (typeof firstMessage === "string" && firstMessage.trim()) {
    messages.push({ role: "user", content: firstMessage.trim() });
  }

  const resolvedTitle =
    typeof title === "string" && title.trim()
      ? title.trim()
      : messages.length
      ? deriveTitle(messages[0].content)
      : "New Chat";

  try {
    const session = await ChatSession.create({ userId, title: resolvedTitle, messages });
    return res.status(201).json(formatSession(session));
  } catch (err) {
    console.error("[chat create session]", err);
    return res.status(500).json({ error: NETWORK_ERROR });
  }
}

/**
 * GET /api/chat/sessions
 * List all sessions for the authenticated user (newest first, no messages).
 * Query: limit (1-100, default 50), skip (default 0)
 */
async function handleListSessions(req, res) {
  const userId = req.authUser._id;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);

  try {
    const [total, sessions] = await Promise.all([
      ChatSession.countDocuments({ userId }),
      ChatSession.find({ userId })
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("title createdAt updatedAt")
        .lean(),
    ]);

    return res.json({
      total,
      limit,
      skip,
      items: sessions.map((s) => ({
        id: s._id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    });
  } catch (err) {
    console.error("[chat list sessions]", err);
    return res.status(500).json({ error: NETWORK_ERROR });
  }
}

/**
 * GET /api/chat/sessions/:id
 * Get a single session with all its messages.
 */
async function handleGetSession(req, res) {
  const userId = req.authUser._id;
  const { id } = req.params;

  if (!isValidId(id)) return res.status(400).json({ error: INVALID_ID });

  try {
    const session = await ChatSession.findOne({ _id: id, userId }).lean();
    if (!session) return res.status(404).json({ error: NOT_FOUND });
    return res.json(formatSession(session));
  } catch (err) {
    console.error("[chat get session]", err);
    return res.status(500).json({ error: NETWORK_ERROR });
  }
}

/**
 * POST /api/chat/sessions/:id/messages
 * Append one or more messages to an existing session.
 * Body: { role, content } OR { messages: [{role, content}] }
 */
async function handleAddMessages(req, res) {
  const userId = req.authUser._id;
  const { id } = req.params;

  if (!isValidId(id)) return res.status(400).json({ error: INVALID_ID });

  let incoming = [];
  if (Array.isArray(req.body.messages)) {
    incoming = req.body.messages;
  } else if (typeof req.body.role === "string" && typeof req.body.content === "string") {
    incoming = [{ role: req.body.role, content: req.body.content }];
  }

  const valid = ["user", "assistant"];
  for (const msg of incoming) {
    if (!valid.includes(msg.role)) {
      return res.status(400).json({ error: `Invalid role "${msg.role}". Must be "user" or "assistant".` });
    }
    if (typeof msg.content !== "string" || !msg.content.trim()) {
      return res.status(400).json({ error: "content is required and must be a non-empty string" });
    }
  }

  if (incoming.length === 0) {
    return res.status(400).json({ error: "No messages provided" });
  }

  const newMessages = incoming.map((m) => ({ role: m.role, content: m.content.trim() }));

  try {
    const session = await ChatSession.findOneAndUpdate(
      { _id: id, userId },
      { $push: { messages: { $each: newMessages } } },
      { new: true }
    );
    if (!session) return res.status(404).json({ error: NOT_FOUND });
    return res.json(formatSession(session));
  } catch (err) {
    console.error("[chat add messages]", err);
    return res.status(500).json({ error: NETWORK_ERROR });
  }
}

/**
 * PATCH /api/chat/sessions/:id
 * Rename a session.
 * Body: { title: string }
 */
async function handleUpdateSession(req, res) {
  const userId = req.authUser._id;
  const { id } = req.params;

  if (!isValidId(id)) return res.status(400).json({ error: INVALID_ID });

  const title = typeof req.body.title === "string" ? req.body.title.trim() : null;
  if (!title) return res.status(400).json({ error: "title is required" });

  try {
    const session = await ChatSession.findOneAndUpdate(
      { _id: id, userId },
      { $set: { title } },
      { new: true }
    );
    if (!session) return res.status(404).json({ error: NOT_FOUND });
    return res.json(formatSession(session));
  } catch (err) {
    console.error("[chat update session]", err);
    return res.status(500).json({ error: NETWORK_ERROR });
  }
}

/**
 * DELETE /api/chat/sessions/:id
 * Permanently delete a session and all its messages.
 */
async function handleDeleteSession(req, res) {
  const userId = req.authUser._id;
  const { id } = req.params;

  if (!isValidId(id)) return res.status(400).json({ error: INVALID_ID });

  try {
    const result = await ChatSession.deleteOne({ _id: id, userId });
    if (result.deletedCount === 0) return res.status(404).json({ error: NOT_FOUND });
    return res.json({ success: true });
  } catch (err) {
    console.error("[chat delete session]", err);
    return res.status(500).json({ error: NETWORK_ERROR });
  }
}

// ── serialiser ─────────────────────────────────────────────────────────────

function formatSession(doc) {
  return {
    id: doc._id,
    title: doc.title,
    messages: (doc.messages || []).map((m) => ({
      id: m._id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

module.exports = {
  handleGuestChat,
  handleRespond,
  handleCreateSession,
  handleListSessions,
  handleGetSession,
  handleAddMessages,
  handleUpdateSession,
  handleDeleteSession,
};
