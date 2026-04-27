const express = require("express");
const {
  handleGuestChat,
  handleRespond,
  handleCreateSession,
  handleListSessions,
  handleGetSession,
  handleAddMessages,
  handleUpdateSession,
  handleDeleteSession,
} = require("../controllers/chatController");
const { authenticate } = require("../middlewares/authMiddleware");

const router = express.Router();

// Guest chat — no auth required, stateless
router.post("/guest", handleGuestChat);

// All routes below require a valid JWT
router.use(authenticate);

router.post("/respond", handleRespond);                   // send + get AI reply (auto-creates session)
router.post("/sessions", handleCreateSession);             // create session
router.get("/sessions", handleListSessions);               // list sessions
router.get("/sessions/:id", handleGetSession);             // get session + messages
router.post("/sessions/:id/messages", handleAddMessages);  // append message(s)
router.patch("/sessions/:id", handleUpdateSession);        // rename session
router.delete("/sessions/:id", handleDeleteSession);       // delete session

module.exports = router;
