import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { connectAll, getPool, serverNames } from "./src/config/db.js";
import apiRoutes from "./src/routes/index.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT;
const HOST = process.env.HOST;

// Health check: confirms every SQL Server connection works (checked in parallel)
app.get("/health/db", async (req, res) => {
  const checkConnection = async (serverName) => {
    try {
      const dbPool = await getPool(serverName);
      const queryResult = await dbPool
        .request()
        .query("SELECT @@SERVERNAME AS server, DB_NAME() AS db");
      return { ok: true, ...queryResult.recordset[0] };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };
  const connectionChecks = await Promise.all(
    serverNames.map(async (serverName) => [serverName, await checkConnection(serverName)]),
  );
  res.json(Object.fromEntries(connectionChecks));
});

app.use("/api", apiRoutes);
await connectAll();
app.listen(PORT, HOST, () => {
  console.log(`Server is running on port ${HOST}:${PORT}`);
});
