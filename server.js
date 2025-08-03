const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.MY_CLIENT_ID;
const CLIENT_SECRET = process.env.MY_SECRET_ID;
const REDIRECT_URI = `${process.env.BACKEND_END_URL}/google/callback`;

const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

const SPREADSHEET_ID = process.env.MY_SPREEDSHEET_ID;

app.post("/add-entry", async (req, res) => {
  const { access_token, values } = req.body;
  if (!access_token || !values) return res.status(400).send("Missing data");

  try {
    const authClient = new google.auth.OAuth2();
    authClient.setCredentials({ access_token });
    const sheets = google.sheets({ version: "v4", auth: authClient });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sheet1!A1",
      valueInputOption: "RAW",
      requestBody: {
        values: [values], // e.g. ["Name", "Email"]
      },
    });

    res.json({ status: "success" });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error adding entry");
  }
});

// 📥 Get all rows from Google Sheet

app.get("/get-entries", async (req, res) => {
  const access_token = req.headers.authorization?.split(" ")[1];
  if (!access_token) return res.status(400).send("Access token missing");

  try {
    const authClient = new google.auth.OAuth2();
    authClient.setCredentials({ access_token });
    const sheets = google.sheets({ version: "v4", auth: authClient });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sheet1!A1:B1000",
    });

    // Filter out empty rows
    const rows = (response.data.values || []).filter(
      (row) => row && row.length > 0 && row[0].trim() !== ""
    );

    // Transform rows here before sending
    const transformedRecords = rows.map((entry, index) => ({
      id: index,
      fields: {
        name: entry[0] || "",
        email: entry[1] || "",
      },
    }));

    res.json({ data: transformedRecords });
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to fetch entries");
  }
});

// 📝 Update a row
app.put("/update-entry", async (req, res) => {
  const { access_token, rowIndex, values } = req.body;
  if (!access_token || rowIndex === undefined || !values)
    return res.status(400).send("Missing data");

  try {
    const authClient = new google.auth.OAuth2();
    authClient.setCredentials({ access_token });
    const sheets = google.sheets({ version: "v4", auth: authClient });

    // Fix: rowIndex + 1 instead of rowIndex + 2
    // If rowIndex is 0 (first data row), we want to update row 1 (A1)
    // If your sheet has headers in row 1, then use rowIndex + 2
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Sheet1!A${rowIndex + 1}`, // Changed from rowIndex + 2 to rowIndex + 1
      valueInputOption: "RAW",
      requestBody: { values: [values] },
    });

    res.json({ status: "updated" });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error updating entry");
  }
});

// 🗑️ Delete entire row (shift rows up)
app.delete("/delete-entry", async (req, res) => {
  const { access_token, rowIndex } = req.body;
  if (!access_token || rowIndex === undefined)
    return res.status(400).send("Missing data");

  try {
    const authClient = new google.auth.OAuth2();
    authClient.setCredentials({ access_token });
    const sheets = google.sheets({ version: "v4", auth: authClient });

    // rowIndex is zero-based from frontend data array
    // Sheet rows start at 1, header is row 1, data rows start at 2
    // So actual sheet row to delete = rowIndex + 1 (0-based to 1-based) + 1 (header) = rowIndex + 2
    const sheetRowToDelete = rowIndex + 1; // same as rowIndex + 2

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: 0, // Usually 0 for first sheet. Confirm with your sheet's actual ID.
                dimension: "ROWS",
                startIndex: sheetRowToDelete - 1, // zero-based, inclusive
                endIndex: sheetRowToDelete, // exclusive, so only one row
              },
            },
          },
        ],
      },
    });

    res.json({ status: "deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error deleting entry");
  }
});

// Scope needed for Gmail read-only access
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

// OAuth client instance for Gmail (same client ID/secret can be used if enabled)
const oAuth2ClientGmail = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  `${process.env.BACKEND_END_URL}/google/callback-gmail`
);


// Step 3: Gmail email search endpoint

app.post("/gmail/search", async (req, res) => {
  const { access_token, query } = req.body;
  if (!access_token) return res.status(400).send("Access token missing");
  if (!query) return res.status(400).send("Search query missing");

  try {
    const authClient = new google.auth.OAuth2();
    authClient.setCredentials({ access_token });

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

        // Flatten headers into fields
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
    res.status(500).send("Error searching emails");
  }
});

const PORT = process.env.PORT;
app.listen(PORT, () =>
  console.log(`Server started at http://localhost:${PORT}`)
);
