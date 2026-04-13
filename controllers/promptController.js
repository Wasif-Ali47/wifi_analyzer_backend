const mongoose = require("mongoose");
const OpenAI = require("openai");
const PromptGeneration = require("../models/promptGenerationModel");
const { NETWORK_ERROR, INPUT_REQUIRED, INVALID_ID, NOT_FOUND } = require("../messages/message");

const SYSTEM_PROMPT = `You are an expert at writing clear, detailed prompts for AI assistants, image models, and coding tools.
Given a short idea from the user, produce one polished prompt they can copy and use.
Rules: output only the final prompt text, no title lines, no quotes around the whole thing, no "Here is your prompt".`;

function getClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    const err = new Error("OPENAI_API_KEY is not configured");
    err.statusCode = 503;
    throw err;
  }
  return new OpenAI({ apiKey: key });
}

function buildUserMessage(body) {
  const input = typeof body.input === "string" ? body.input.trim() : "";
  const extra = typeof body.context === "string" ? body.context.trim() : "";
  if (!input) return "";
  if (!extra) return input;
  return `Idea:\n${input}\n\nExtra context or constraints:\n${extra}`;
}

async function handleGeneratePrompt(req, res) {
  const userContent = buildUserMessage(req.body);
  if (!userContent) {
    return res.status(400).json({ error: INPUT_REQUIRED });
  }

  const model = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();

  let client;
  try {
    client = getClient();
  } catch (e) {
    return res.status(e.statusCode || 503).json({ error: e.message });
  }

  let generatedPrompt;
  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.7,
    });
    generatedPrompt = completion.choices?.[0]?.message?.content?.trim() || "";
  } catch (err) {
    const msg =
      err?.response?.data?.error?.message ||
      err?.error?.message ||
      err?.message ||
      "OpenAI request failed";
    console.error("[prompt generate]", msg, err?.stack);
    return res.status(502).json({ error: msg });
  }

  if (!generatedPrompt) {
    return res.status(502).json({ error: "Empty response from model" });
  }

  try {
    const doc = await PromptGeneration.create({
      input: typeof req.body.input === "string" ? req.body.input.trim() : userContent,
      generatedPrompt,
      model,
    });
    return res.status(201).json({
      id: doc._id,
      input: doc.input,
      generatedPrompt: doc.generatedPrompt,
      model: doc.model,
      createdAt: doc.createdAt,
    });
  } catch (err) {
    console.error("[prompt save]", err);
    return res.status(500).json({ error: NETWORK_ERROR });
  }
}

async function handleListPrompts(req, res) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);

  try {
    const [total, rows] = await Promise.all([
      PromptGeneration.countDocuments({}),
      PromptGeneration.find({})
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("input generatedPrompt model createdAt updatedAt")
        .lean(),
    ]);

    return res.json({
      total,
      limit,
      skip,
      items: rows.map((row) => ({
        id: row._id,
        input: row.input,
        generatedPrompt: row.generatedPrompt,
        model: row.model,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: NETWORK_ERROR });
  }
}

async function handleGetPrompt(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: INVALID_ID });
  }

  try {
    const row = await PromptGeneration.findById(id).lean();
    if (!row) {
      return res.status(404).json({ error: NOT_FOUND });
    }
    return res.json({
      id: row._id,
      input: row.input,
      generatedPrompt: row.generatedPrompt,
      model: row.model,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: NETWORK_ERROR });
  }
}

module.exports = {
  handleGeneratePrompt,
  handleListPrompts,
  handleGetPrompt,
};
