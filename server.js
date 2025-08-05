const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.MY_CLIENT_ID;
const CLIENT_SECRET = process.env.MY_SECRET_ID;
const SPREADSHEET_ID = process.env.MY_SPREEDSHEET_ID;

// In-memory token storage (use Redis/Database in production)
const tokenStore = new Map();

// Helper function to create OAuth2 client
const createAuthClient = (redirectUri = null) => {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri);
};

// Helper function to check if token is expired or about to expire
const isTokenExpired = (tokenData) => {
  if (!tokenData.expires_at) return false;

  // Consider token expired if it expires in next 5 minutes
  const bufferTime = 5 * 60 * 1000; // 5 minutes
  return Date.now() > tokenData.expires_at - bufferTime;
};

// Helper function to refresh access token
const refreshAccessToken = async (refreshToken, userId = "default") => {
  try {
    const authClient = createAuthClient();
    authClient.setCredentials({
      refresh_token: refreshToken,
    });

    console.log("Attempting to refresh token for user:", userId);

    // Refresh the token
    const { credentials } = await authClient.refreshAccessToken();

    // Store the new token data
    const tokenData = {
      access_token: credentials.access_token,
      refresh_token: credentials.refresh_token || refreshToken, // Keep old refresh token if new one not provided
      expires_at: credentials.expiry_date || Date.now() + 3600 * 1000,
      token_type: credentials.token_type || "Bearer",
    };

    // Store in memory (use your preferred storage)
    tokenStore.set(userId, tokenData);

    console.log("Token refreshed successfully for user:", userId);
    return tokenData;
  } catch (error) {
    console.error("Token refresh failed:", error.message);
    throw new Error("Token refresh failed: " + error.message);
  }
};

// Middleware to handle token validation and refresh
const validateAndRefreshToken = async (req, res, next) => {
  try {
    let access_token;
    let refresh_token;
    let userId = "default"; // Adjust per your user/session logic

    // 1. Prefer Authorization header (always present for GET, often also for POST/PUT)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      access_token = authHeader.split(" ")[1];
    }

    // 2. Refresh token: first from custom header, fallback to stored
    refresh_token =
      req.headers["x-refresh-token"] || tokenStore.get(userId)?.refresh_token;

    // 3. For POST/PUT: Accept access_token and refresh_token from body, if provided (but do not overwrite from headers if already set)
    if (req.body && req.body.access_token && !access_token) {
      access_token = req.body.access_token;
    }
    if (req.body && req.body.refresh_token && !refresh_token) {
      refresh_token = req.body.refresh_token;
    }

    // 4. Grab expires_at if present in body or from store
    const expires_at =
      req.body?.expires_at ?? tokenStore.get(userId)?.expires_at;

    if (!access_token) {
      return res.status(401).json({ error: "Access token missing" });
    }

    // 5. Main token object
    let tokenData = {
      access_token,
      refresh_token,
      expires_at,
    };

    // 6. Check and refresh if needed
    if (refresh_token && isTokenExpired(tokenData)) {
      console.log("Token expired, attempting refresh...");
      try {
        tokenData = await refreshAccessToken(refresh_token, userId);

        // Send new token details back for client to store
        res.set("X-New-Access-Token", tokenData.access_token);
        res.set("X-Token-Refreshed", "true");

        req.tokenData = tokenData;
        req.access_token = tokenData.access_token;
      } catch (refreshError) {
        return res.status(401).json({
          error: "Token refresh failed",
          requiresReauth: true,
        });
      }
    } else {
      req.tokenData = tokenData;
      req.access_token = access_token;

      // Store token data for future refresh if available
      if (refresh_token) {
        tokenStore.set(userId, tokenData);
      }
    }

    next();
  } catch (error) {
    console.error("Token validation error:", error);
    res.status(401).json({ error: "Token validation failed" });
  }
};

// OAuth callback endpoint to handle initial token exchange
app.post("/oauth/callback", async (req, res) => {
  const { code, redirect_uri } = req.body;

  if (!code) {
    return res.status(400).json({ error: "Authorization code missing" });
  }

  console.log("OAuth callback received:", {
    code: code.substring(0, 20) + "...",
    redirect_uri,
    client_id: CLIENT_ID?.substring(0, 10) + "...",
    has_client_secret: !!CLIENT_SECRET,
  });

  try {
    const authClient = createAuthClient(redirect_uri);

    // Exchange code for tokens
    const { tokens } = await authClient.getToken(code);

    console.log("Tokens received:", {
      has_access_token: !!tokens.access_token,
      has_refresh_token: !!tokens.refresh_token,
      expires_in: tokens.expiry_date,
    });

    // Calculate expiration time
    const expires_at = tokens.expiry_date || Date.now() + 3600 * 1000;

    const tokenData = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at,
      token_type: tokens.token_type || "Bearer",
    };

    // Store tokens (use proper user identification in production)
    const userId = "default";
    tokenStore.set(userId, tokenData);

    res.json(tokenData);
  } catch (error) {
    console.error("OAuth callback error details:", {
      error: error.message,
      code: error.code,
      status: error.status,
      response: error.response?.data,
    });
    res.status(500).json({
      error: "OAuth exchange failed",
      details: error.message,
      debug:
        process.env.NODE_ENV === "development"
          ? error.response?.data
          : undefined,
    });
  }
});

// Token refresh endpoint
app.post("/oauth/refresh", async (req, res) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res.status(400).json({ error: "Refresh token missing" });
  }

  try {
    const tokenData = await refreshAccessToken(refresh_token);
    res.json(tokenData);
  } catch (error) {
    res
      .status(400)
      .json({ error: "Token refresh failed", requiresReauth: true });
  }
});

// Apply token validation middleware to protected routes
app.use(
  [
    "/add-entry",
    "/get-entries",
    "/update-entry",
    "/delete-entry",
    "/gmail/search",
  ],
  validateAndRefreshToken
);

app.post("/add-entry", async (req, res) => {
  const { values } = req.body;
  if (!values) return res.status(400).json({ error: "Missing values" });

  try {
    const authClient = createAuthClient();
    authClient.setCredentials({ access_token: req.access_token });
    const sheets = google.sheets({ version: "v4", auth: authClient });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sheet1!A1",
      valueInputOption: "RAW",
      requestBody: {
        values: [values],
      },
    });

    res.json({ status: "success" });
  } catch (err) {
    console.error("Add entry error:", err);

    // Check if it's an auth error
    if (err.code === 401 || err.code === 403) {
      return res
        .status(401)
        .json({ error: "Authentication failed", requiresReauth: true });
    }

    res.status(500).json({ error: "Error adding entry" });
  }
});

app.get("/get-entries", async (req, res) => {
  try {
    const authClient = createAuthClient();
    authClient.setCredentials({ access_token: req.access_token });
    const sheets = google.sheets({ version: "v4", auth: authClient });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sheet1!A1:B1000",
    });

    const rows = (response.data.values || []).filter(
      (row) => row && row.length > 0 && row[0].trim() !== ""
    );

    const transformedRecords = rows.map((entry, index) => ({
      id: index,
      fields: {
        name: entry[0] || "",
        email: entry[1] || "",
      },
    }));

    res.json({ data: transformedRecords });
  } catch (err) {
    console.error("Get entries error:", err);

    if (err.code === 401 || err.code === 403) {
      return res
        .status(401)
        .json({ error: "Authentication failed", requiresReauth: true });
    }

    res.status(500).json({ error: "Failed to fetch entries" });
  }
});

app.put("/update-entry", async (req, res) => {
  const { rowIndex, values } = req.body;
  if (rowIndex === undefined || !values) {
    return res.status(400).json({ error: "Missing data" });
  }

  try {
    const authClient = createAuthClient();
    authClient.setCredentials({ access_token: req.access_token });
    const sheets = google.sheets({ version: "v4", auth: authClient });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Sheet1!A${rowIndex + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: [values] },
    });

    res.json({ status: "updated" });
  } catch (err) {
    console.error("Update entry error:", err);

    if (err.code === 401 || err.code === 403) {
      return res
        .status(401)
        .json({ error: "Authentication failed", requiresReauth: true });
    }

    res.status(500).json({ error: "Error updating entry" });
  }
});

app.delete("/delete-entry", async (req, res) => {
  const { rowIndex } = req.body;
  if (rowIndex === undefined) {
    return res.status(400).json({ error: "Missing rowIndex" });
  }

  try {
    const authClient = createAuthClient();
    authClient.setCredentials({ access_token: req.access_token });
    const sheets = google.sheets({ version: "v4", auth: authClient });

    const sheetRowToDelete = rowIndex + 1;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: 0,
                dimension: "ROWS",
                startIndex: sheetRowToDelete - 1,
                endIndex: sheetRowToDelete,
              },
            },
          },
        ],
      },
    });

    res.json({ status: "deleted" });
  } catch (err) {
    console.error("Delete entry error:", err);

    if (err.code === 401 || err.code === 403) {
      return res
        .status(401)
        .json({ error: "Authentication failed", requiresReauth: true });
    }

    res.status(500).json({ error: "Error deleting entry" });
  }
});

app.post("/gmail/search", async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Search query missing" });

  try {
    const authClient = createAuthClient();
    authClient.setCredentials({ access_token: req.access_token });

    const gmail = google.gmail({ version: "v1", auth: authClient });

    const searchRes = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 10,
    });

    const messages = searchRes.data.messages || [];

    const detailedRecords = await Promise.all(
      messages.map(async (msg) => {
        const messageDetail = await gmail.users.messages.get({
          userId: "me",
          id: msg.id,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"],
        });

        const headersArray = messageDetail.data.payload.headers || [];
        const fields = {
          Snippet: messageDetail.data.snippet,
        };

        for (const header of headersArray) {
          if (["From", "Subject", "Date"].includes(header.name)) {
            fields[header.name] = header.value;
          }
        }

        return {
          id: msg.id,
          fields,
        };
      })
    );

    res.json({ records: detailedRecords });
  } catch (err) {
    console.error("Gmail search error:", err);

    if (err.code === 401 || err.code === 403) {
      return res
        .status(401)
        .json({ error: "Authentication failed", requiresReauth: true });
    }

    res.status(500).json({ error: "Error searching emails" });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Debug endpoint to check OAuth configuration
app.get("/oauth/debug", (req, res) => {
  res.json({
    client_id: CLIENT_ID ? CLIENT_ID.substring(0, 20) + "..." : "NOT_SET",
    client_secret: CLIENT_SECRET
      ? "SET (length: " + CLIENT_SECRET.length + ")"
      : "NOT_SET",
    spreadsheet_id: SPREADSHEET_ID ? "SET" : "NOT_SET",
    environment: process.env.NODE_ENV || "development",
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`Server started at http://localhost:${PORT}`)
);
