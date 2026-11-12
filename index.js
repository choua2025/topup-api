import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { connectAll, getDb135, getDb22 } from "./src/config/db.js";
import topupRoutes from "./src/routes/topup.routes.js";
import transferRoutes from "./src/routes/transfer.routes.js";
import packageRoutes from "./src/routes/package.routes.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// Health check: confirms both SQL Server connections work
app.get("/health/db", async (req, res) => {
  const checkConnection = async (getDbPool) => {
    try {
      const dbPool = await getDbPool();
      const queryResult = await dbPool
        .request()
        .query("SELECT @@SERVERNAME AS server, DB_NAME() AS db");
      return { ok: true, ...queryResult.recordset[0] };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };
  res.json({
    db135: await checkConnection(getDb135),
    db22: await checkConnection(getDb22),
  });
});

app.use("/api/topup", topupRoutes);
app.use("/api/transfer", transferRoutes);
app.use("/api/package", packageRoutes);
await connectAll();
app.listen(process.env.PORT, async () => {
  console.log(`Server is running on port ${process.env.PORT}`);
});
