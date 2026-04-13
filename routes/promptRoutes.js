const express = require("express");
const {
  handleGeneratePrompt,
  handleListPrompts,
  handleGetPrompt,
} = require("../controllers/promptController");

const router = express.Router();

router.post("/generate", handleGeneratePrompt);
router.get("/", handleListPrompts);
router.get("/:id", handleGetPrompt);

module.exports = router;
