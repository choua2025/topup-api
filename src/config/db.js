import sql from "mssql";
import dotenv from "dotenv";

dotenv.config();

// Shared options used by every SQL Server connection
const baseOptions = {
    port: Number(process.env.DB_PORT) || 1433,
    options: {
        encrypt: false, // internal network server
        trustServerCertificate: true,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 15000,
    requestTimeout: 30000,
};

// Per-server settings
const dbConfigs = {
    db135: {
        server: process.env.DB_HOST_135,
        user: process.env.DB_USER_135,
        password: process.env.DB_PASSWORD_135,
        database: process.env.DB_NAME_135,
    },
    db22: {
        server: process.env.DB_HOST_22,
        user: process.env.DB_USER_22,
        password: process.env.DB_PASSWORD_22,
        database: process.env.DB_NAME_22,
    },
};

const connectionPools = {};

// Returns a cached connection pool for the given server name
const getPool = (serverName) => {
    if (!connectionPools[serverName]) {
        connectionPools[serverName] = new sql.ConnectionPool({ ...baseOptions, ...dbConfigs[serverName] })
            .connect()
            .catch((connectionError) => {
                delete connectionPools[serverName]; // allow retry on the next call
                throw connectionError;
            });
    }
    return connectionPools[serverName];
};

export const getDb135 = () => getPool("db135");
export const getDb22 = () => getPool("db22");

// Connect to all servers at startup and log the result
export const connectAll = async () => {
    const serverNames = Object.keys(dbConfigs);
    const connectionResults = await Promise.allSettled(serverNames.map(getPool));
    connectionResults.forEach((connectionResult, index) => {
        const serverName = serverNames[index];
        if (connectionResult.status === "fulfilled") console.log(`${serverName} connected`);
        else console.error(`${serverName} connection failed:`, connectionResult.reason.message);
    });
};

export { sql };
