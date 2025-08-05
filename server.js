const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
require("dotenv").config();
const SPREADSHEET_ID = process.env.MY_SPREEDSHEET_ID;

// In-memory token and credential storage (should use sessions/db for real users)
const tokenStore = new Map();

const app = express();
app.use(cors());
app.use(express.json());

// Helper to create OAuth2 client, now using dynamic creds
function createAuthClient(client_id, client_secret, redirectUri = null) {
  return new google.auth.OAuth2(client_id, client_secret, redirectUri);
}

function isTokenExpired(tokenData) {
  if (!tokenData.expires_at) return false;
  const bufferTime = 5 * 60 * 1000; // 5 min
  return Date.now() > tokenData.expires_at - bufferTime;
}

// Stores clientId/clientSecret access/refresh_token user-by-user (here 'default')
function getUserSession(userId = "default") {
  const sess = tokenStore.get(userId);
  if (!sess) throw new Error("No session found");
  return sess;
}

function setUserSession(userId, session) {
  tokenStore.set(userId, session);
}

// Refresh token (using user credentials)
async function refreshAccessToken(refreshToken, userId = "default") {
  const session = getUserSession(userId);
  const authClient = createAuthClient(session.client_id, session.client_secret);
  authClient.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await authClient.refreshAccessToken();
  const tokenData = {
    ...session,
    access_token: credentials.access_token,
    refresh_token: credentials.refresh_token || refreshToken,
    expires_at: credentials.expiry_date || Date.now() + 3600 * 1000,
    token_type: credentials.token_type || "Bearer",
  };
  setUserSession(userId, tokenData);
  return tokenData;
}

// Middleware to validate/refresh with per-user credentials (via tokenStore)
async function validateAndRefreshToken(req, res, next) {
  try {
    const userId = "default"; // Adapt for multiple users
    const session = tokenStore.get(userId);

    let access_token =
      req.headers.authorization?.split(" ")[1] || req.body?.access_token;
    let refresh_token =
      req.headers["x-refresh-token"] ||
      req.body?.refresh_token ||
      session?.refresh_token;
    let expires_at = req.body?.expires_at ?? session?.expires_at;

    if (!session || !session.client_id || !session.client_secret) {
      return res.status(401).json({ error: "OAuth credentials missing" });
    }
    if (!access_token) {
      return res.status(401).json({ error: "Access token missing" });
    }

    let tokenData = { ...session, access_token, refresh_token, expires_at };

    // Check expiry and perform refresh if needed
    if (refresh_token && isTokenExpired(tokenData)) {
      try {
        tokenData = await refreshAccessToken(refresh_token, userId);
        res.set("X-New-Access-Token", tokenData.access_token);
        res.set("X-Token-Refreshed", "true");
      } catch {
        return res
          .status(401)
          .json({ error: "Token refresh failed", requiresReauth: true });
      }
    }

    req.tokenData = tokenData;
    req.access_token = tokenData.access_token;
    next();
  } catch (error) {
    console.error("Token validation error:", error);
    res.status(401).json({ error: "Token validation failed" });
  }
}

// OAuth callback: receive code and creds, create token + store ALL info
app.post("/oauth/callback", async (req, res) => {
  const { code, redirect_uri, client_id, client_secret } = req.body;
  if (!code || !client_id || !client_secret) {
    return res
      .status(400)
      .json({ error: "Missing authorization code or credentials" });
  }

  try {
    const authClient = createAuthClient(client_id, client_secret, redirect_uri);
    const { tokens } = await authClient.getToken(code);

    const tokenData = {
      client_id,
      client_secret,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expiry_date || Date.now() + 3600 * 1000,
      token_type: tokens.token_type || "Bearer",
    };

    // In demo, only single user. Use a session/user id for multiple end-users!
    setUserSession("default", tokenData);

    res.json({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: tokenData.expires_at,
      token_type: tokenData.token_type,
    });
  } catch (error) {
    console.error("OAuth callback error details:", error);
    res.status(500).json({
      error: "OAuth exchange failed",
      details: error.message,
    });
  }
});

// Refresh endpoint (uses stored client ID/secret for user)
app.post("/oauth/refresh", async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token)
    return res.status(400).json({ error: "Refresh token missing" });

  try {
    const tokenData = await refreshAccessToken(refresh_token);
    res.json(tokenData);
  } catch (error) {
    res
      .status(400)
      .json({ error: "Token refresh failed", requiresReauth: true });
  }
});

// Only allow after auth: always uses session's credentials for Google API
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
  try {
    const session = getUserSession("default");
    const authClient = createAuthClient(
      session.client_id,
      session.client_secret
    );
    authClient.setCredentials({ access_token: req.access_token });
    const sheets = google.sheets({ version: "v4", auth: authClient });
    const { values } = req.body;

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sheet1!A1",
      valueInputOption: "RAW",
      requestBody: { values: [values] },
    });

    res.json({ status: "success" });
  } catch (err) {
    console.error("Add entry error:", err);
    if (err.code === 401 || err.code === 403)
      return res
        .status(401)
        .json({ error: "Authentication failed", requiresReauth: true });
    res.status(500).json({ error: "Error adding entry" });
  }
});

app.get("/get-entries", async (req, res) => {
  console.log("SPREADSHEET_ID", SPREADSHEET_ID);

  try {
    const session = getUserSession("default");
    const authClient = createAuthClient(
      session.client_id,
      session.client_secret
    );
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
    if (err.code === 401 || err.code === 403)
      return res
        .status(401)
        .json({ error: "Authentication failed", requiresReauth: true });
    res.status(500).json({ error: "Failed to fetch entries" });
  }
});

// (Repeat the same "session/creds per user" pattern for update-entry/delete-entry/gmail/search...)

app.put("/update-entry", async (req, res) => {
  const { rowIndex, values } = req.body;
  if (rowIndex === undefined || !values)
    return res.status(400).json({ error: "Missing data" });

  try {
    const session = getUserSession("default");
    const authClient = createAuthClient(
      session.client_id,
      session.client_secret
    );
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
    if (err.code === 401 || err.code === 403)
      return res
        .status(401)
        .json({ error: "Authentication failed", requiresReauth: true });
    res.status(500).json({ error: "Error updating entry" });
  }
});

app.delete("/delete-entry", async (req, res) => {
  const { rowIndex } = req.body;
  if (rowIndex === undefined)
    return res.status(400).json({ error: "Missing rowIndex" });

  try {
    const session = getUserSession("default");
    const authClient = createAuthClient(
      session.client_id,
      session.client_secret
    );
    authClient.setCredentials({ access_token: req.access_token });
    const sheets = google.sheets({ version: "v4", auth: authClient });

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: 0,
                dimension: "ROWS",
                startIndex: rowIndex,
                endIndex: rowIndex + 1,
              },
            },
          },
        ],
      },
    });
    res.json({ status: "deleted" });
  } catch (err) {
    console.error("Delete entry error:", err);
    if (err.code === 401 || err.code === 403)
      return res
        .status(401)
        .json({ error: "Authentication failed", requiresReauth: true });
    res.status(500).json({ error: "Error deleting entry" });
  }
});

app.post("/gmail/search", async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Search query missing" });

  try {
    const session = getUserSession("default");
    const authClient = createAuthClient(
      session.client_id,
      session.client_secret
    );
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
        const fields = { Snippet: messageDetail.data.snippet };
        for (const header of headersArray) {
          if (["From", "Subject", "Date"].includes(header.name)) {
            fields[header.name] = header.value;
          }
        }
        return { id: msg.id, fields };
      })
    );
    res.json({ records: detailedRecords });
  } catch (err) {
    console.error("Gmail search error:", err);
    if (err.code === 401 || err.code === 403)
      return res
        .status(401)
        .json({ error: "Authentication failed", requiresReauth: true });
    res.status(500).json({ error: "Error searching emails" });
  }
});

// Health and debug endpoints remain as you like.

const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`Server started at http://localhost:${PORT}`)
);
