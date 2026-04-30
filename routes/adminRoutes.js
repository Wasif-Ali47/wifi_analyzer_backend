const express = require("express");
const { verifyAdmin } = require("../middlewares/adminAuthMiddleware");
const { verifyAdminOrServiceKey } = require("../middlewares/serviceKeyMiddleware");
const {
  getUsers,
  updateUser,
  setUserBanState,
  getUsageOverview,
  broadcastNotification,
} = require("../controllers/adminController");

const router = express.Router();

router.get("/test", (req, res) => {
  res.json({ success: true, message: "Admin routes are working" });
});

const adminOrService = verifyAdminOrServiceKey(verifyAdmin);
router.use(adminOrService);
router.get("/users", getUsers);
router.put("/users/:id", updateUser);
router.patch("/users/:id/ban", setUserBanState);
router.patch("/users/:id/toggle", setUserBanState);
router.get("/usage", getUsageOverview);
router.post("/notifications/broadcast", broadcastNotification);

module.exports = router;
