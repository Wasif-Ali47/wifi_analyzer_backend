const mongoose = require("mongoose");

const promptGenerationSchema = new mongoose.Schema(
  {
    input: { type: String, required: true, trim: true },
    generatedPrompt: { type: String, required: true, trim: true },
    model: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PromptGeneration", promptGenerationSchema);
