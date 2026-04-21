const mongoose = require("mongoose");
const User = require("../models/usersModel");
const PushDeviceToken = require("../models/pushDeviceTokenModel");
const { ensureFirebaseAdmin } = require("../utils/firebaseAdminInit");

async function getUsers(req, res) {
  try {
    const users = await User.find({})
      .select("-password -otp -resetOTP")
      .sort({ createdAt: -1 })
      .lean();

    const rows = users.map((u) => ({
      id: u._id,
      name: u.name || "",
      email: u.email || "",
      profession: u.profession || "",
      image: u.image || "",
      emailVerified: !!u.emailVerified,
      isBanned: !!u.isBanned,
      bannedAt: u.bannedAt || null,
      bannedReason: u.bannedReason || "",
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      deviceTokenCount: Array.isArray(u.deviceTokens) ? u.deviceTokens.length : 0,
      openAiUsage: {
        promptTokens: Number(u.openAiUsage?.promptTokens) || 0,
        completionTokens: Number(u.openAiUsage?.completionTokens) || 0,
        totalTokens: Number(u.openAiUsage?.totalTokens) || 0,
        requestCount: Number(u.openAiUsage?.requestCount) || 0,
        lastUsedAt: u.openAiUsage?.lastUsedAt || null,
      },
    }));

    return res.json({
      success: true,
      users: rows,
    });
  } catch (error) {
    console.error("[admin:getUsers] error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch users",
      error: error.message,
    });
  }
}

async function updateUser(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id",
      });
    }

    const allowedFields = ["name", "profession", "email", "emailVerified"];
    const payload = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) {
        payload[key] = req.body[key];
      }
    }

    if (payload.email && typeof payload.email === "string") {
      payload.email = payload.email.trim().toLowerCase();
    }

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields to update",
      });
    }

    const user = await User.findByIdAndUpdate(id, payload, { new: true }).select("-password");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.json({
      success: true,
      message: "User updated successfully",
      user,
    });
  } catch (error) {
    console.error("[admin:updateUser] error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update user",
      error: error.message,
    });
  }
}

async function setUserBanState(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id",
      });
    }

    const banValue = req.body?.isBanned;
    const isBanned =
      banValue === true ||
      banValue === "true" ||
      banValue === 1 ||
      banValue === "1";
    const update = {
      isBanned,
      bannedAt: isBanned ? new Date() : null,
      bannedReason: isBanned ? String(req.body?.bannedReason || "").trim() : "",
    };

    const user = await User.findByIdAndUpdate(id, update, { new: true }).select("-password");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.json({
      success: true,
      message: isBanned ? "User banned successfully" : "User unbanned successfully",
      user: {
        id: user._id,
        email: user.email,
        isBanned: user.isBanned,
        bannedAt: user.bannedAt,
        bannedReason: user.bannedReason,
      },
    });
  } catch (error) {
    console.error("[admin:setUserBanState] error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update user ban state",
      error: error.message,
    });
  }
}

async function getUsageOverview(req, res) {
  try {
    const agg = await User.aggregate([
      {
        $group: {
          _id: null,
          users: { $sum: 1 },
          bannedUsers: {
            $sum: { $cond: [{ $eq: ["$isBanned", true] }, 1, 0] },
          },
          totalPromptTokens: { $sum: { $ifNull: ["$openAiUsage.promptTokens", 0] } },
          totalCompletionTokens: { $sum: { $ifNull: ["$openAiUsage.completionTokens", 0] } },
          totalTokens: { $sum: { $ifNull: ["$openAiUsage.totalTokens", 0] } },
          totalRequests: { $sum: { $ifNull: ["$openAiUsage.requestCount", 0] } },
        },
      },
    ]);

    const topUsers = await User.find({})
      .select("name email isBanned openAiUsage")
      .sort({ "openAiUsage.totalTokens": -1 })
      .limit(20)
      .lean();

    const summary = agg[0] || {
      users: 0,
      bannedUsers: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalRequests: 0,
    };

    return res.json({
      success: true,
      summary,
      topUsers: topUsers.map((u) => ({
        id: u._id,
        name: u.name || "",
        email: u.email || "",
        isBanned: !!u.isBanned,
        openAiUsage: {
          promptTokens: Number(u.openAiUsage?.promptTokens) || 0,
          completionTokens: Number(u.openAiUsage?.completionTokens) || 0,
          totalTokens: Number(u.openAiUsage?.totalTokens) || 0,
          requestCount: Number(u.openAiUsage?.requestCount) || 0,
          lastUsedAt: u.openAiUsage?.lastUsedAt || null,
        },
      })),
    });
  } catch (error) {
    console.error("[admin:getUsageOverview] error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch usage overview",
      error: error.message,
    });
  }
}

async function broadcastNotification(req, res) {
  try {
    const firebaseAdmin = ensureFirebaseAdmin();
    if (!firebaseAdmin) {
      return res.status(503).json({
        success: false,
        message: "Push notifications not configured. Missing Firebase setup.",
      });
    }

    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    const data = req.body?.data && typeof req.body.data === "object" ? req.body.data : {};

    if (!title || !body) {
      return res.status(400).json({
        success: false,
        message: "title and body are required",
      });
    }

    const usersWithTokens = await User.find({
      "deviceTokens.0": { $exists: true },
      isBanned: { $ne: true },
    }).select("deviceTokens");

    const uniqueTokens = new Set();
    for (const user of usersWithTokens) {
      for (const device of user.deviceTokens || []) {
        if (device?.token) {
          uniqueTokens.add(device.token);
        }
      }
    }

    const standaloneRows = await PushDeviceToken.find({ isActive: true }).select("token").lean();
    for (const row of standaloneRows) {
      if (row?.token) {
        uniqueTokens.add(row.token);
      }
    }

    const tokens = Array.from(uniqueTokens);
    if (!tokens.length) {
      return res.json({
        success: true,
        message: "No registered device tokens found",
        totalTokens: 0,
        successCount: 0,
        failureCount: 0,
      });
    }

    const chunkSize = 500;
    let successCount = 0;
    let failureCount = 0;
    for (let i = 0; i < tokens.length; i += chunkSize) {
      const chunk = tokens.slice(i, i + chunkSize);
      const response = await firebaseAdmin.messaging().sendEachForMulticast({
        tokens: chunk,
        notification: { title, body },
        data: Object.entries(data).reduce((acc, [k, v]) => {
          acc[String(k)] = String(v);
          return acc;
        }, {}),
      });

      successCount += response.successCount || 0;
      failureCount += response.failureCount || 0;
    }

    return res.json({
      success: true,
      message: "Broadcast notification sent",
      totalTokens: tokens.length,
      successCount,
      failureCount,
    });
  } catch (error) {
    console.error("[admin:broadcastNotification] error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to send broadcast notification",
      error: error.message,
    });
  }
}

module.exports = {
  getUsers,
  updateUser,
  setUserBanState,
  getUsageOverview,
  broadcastNotification,
};
