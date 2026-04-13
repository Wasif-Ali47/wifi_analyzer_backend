require("dotenv").config();

const express = require("express");
const cors = require("cors");
const MongoDBConnect = require("./connection/connection");
const ensureBody = require("./middlewares/parseRequest");
const promptRouter = require("./routes/promptRoutes");

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.error("Missing MONGODB_URI. Create a .env file (see .env.example).");
  process.exit(1);
}

const app = express();
const port = Number(process.env.PORT) || 8000;

app.use(
  cors({
    origin: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(ensureBody);

app.get("/", (req, res) => {
  res.json({
    service: "AI prompt generator",
    endpoints: {
      generate: "POST /api/prompts/generate",
      list: "GET /api/prompts",
      getOne: "GET /api/prompts/:id",
    },
  });
});

app.use("/api/prompts", promptRouter);

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

MongoDBConnect(mongoUri)
  .then(() => {
    app.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  })
  .catch(() => process.exit(1));
