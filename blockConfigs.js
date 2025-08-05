// blockConfigs.js
// Export as a MAP for fast lookup by blockId

module.exports = {
  "airtable-crud": {
    operations: {
      fetch: {
        service: "airtable",
        method: "GET",
        buildUrl: ({ inputs, config }) =>
          `${config.baseurl}/${inputs.baseId}/${inputs.tableName}`,
        buildHeaders: ({ credentials }) => ({
          Authorization: `Bearer ${credentials.apiKey}`,
        }),
        requiredFields: ["baseId", "tableName"],
        responseField: "records",
        transform: null,
      },
      create: {
        service: "airtable",
        method: "POST",
        buildUrl: ({ inputs, config }) =>
          `${config.baseurl}/${inputs.baseId}/${inputs.tableName}`,
        buildHeaders: ({ credentials }) => ({
          Authorization: `Bearer ${credentials.apiKey}`,
          "Content-Type": "application/json",
        }),
        buildPayload: ({ inputs }) => ({ fields: { ...inputs.dataFields } }),
        requiredFields: ["baseId", "tableName"],
        responseField: null,
      },
      update: {
        service: "airtable",
        method: "PATCH",
        buildUrl: ({ inputs, config }) =>
          `${config.baseurl}/${inputs.baseId}/${inputs.tableName}/${inputs.recordId}`,
        buildHeaders: ({ credentials }) => ({
          Authorization: `Bearer ${credentials.apiKey}`,
          "Content-Type": "application/json",
        }),
        buildPayload: ({ inputs }) => ({ fields: { ...inputs.dataFields } }),
        requiredFields: ["baseId", "tableName", "recordId"],
        responseField: null,
      },
      delete: {
        service: "airtable",
        method: "DELETE",
        buildUrl: ({ inputs, config }) =>
          `${config.baseurl}/${inputs.baseId}/${inputs.tableName}/${inputs.recordId}`,
        buildHeaders: ({ credentials }) => ({
          Authorization: `Bearer ${credentials.apiKey}`,
        }),
        requiredFields: ["baseId", "tableName", "recordId"],
        responseField: null,
      },
    },
    config: {
      baseurl: "https://api.airtable.com/v0",
    },
  },

  gmail_search_emails: {
    operations: {
      fetch: {
        service: "gmail",
        method: "POST",
        async execute({ credentials, inputs }) {
          const { google } = require("googleapis");
          const authClient = new google.auth.OAuth2(
            credentials.clientId,
            credentials.secretId
          );
          authClient.setCredentials({ access_token: credentials.access_token });

          const gmail = google.gmail({ version: "v1", auth: authClient });
          const searchRes = await gmail.users.messages.list({
            userId: "me",
            q: inputs.query,
            maxResults: 10,
          });
          const messages = searchRes.data.messages || [];
          const records = await Promise.all(
            messages.map(async (msg) => {
              const messageDetail = await gmail.users.messages.get({
                userId: "me",
                id: msg.id,
                format: "metadata",
                metadataHeaders: ["From", "Subject", "Date"],
              });
              const headers = {};
              (messageDetail.data.payload.headers || []).forEach((h) => {
                if (["From", "Subject", "Date"].includes(h.name))
                  headers[h.name] = h.value;
              });
              headers.Snippet = messageDetail.data.snippet;
              return { id: msg.id, fields: headers };
            })
          );
          return { records };
        },
      },
    },
  },

  "google-sheets-crud": {
    operations: {
      fetch: {
        service: "googlesheets",
        method: "GET",
        async execute({ credentials }) {
          const { google } = require("googleapis");
          const authClient = new google.auth.OAuth2(
            credentials.clientId,
            credentials.secretId
          );
          authClient.setCredentials({ access_token: credentials.access_token });
          const sheets = google.sheets({ version: "v4", auth: authClient });
          const spreadsheetId = process.env.MY_SPREEDSHEET_ID;
          const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: "Sheet1!A1:B1000",
          });
          const rows = (response.data.values || []).filter(
            (row) => row && row.length > 0 && row[0].trim() !== ""
          );
          const transformedRecords = rows.map((entry, index) => ({
            id: index,
            fields: { name: entry[0] || "", email: entry[1] || "" },
          }));
          return { data: transformedRecords };
        },
      },
      create: {
        service: "googlesheets",
        method: "POST",
        async execute({ credentials, inputs }) {
          const { google } = require("googleapis");
          const authClient = new google.auth.OAuth2(
            credentials.clientId,
            credentials.secretId
          );
          authClient.setCredentials({ access_token: credentials.access_token });
          const sheets = google.sheets({ version: "v4", auth: authClient });
          const spreadsheetId = process.env.MY_SPREEDSHEET_ID;
          await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: "Sheet1!A1",
            valueInputOption: "RAW",
            requestBody: { values: [inputs.valuesArray] },
          });
          return { status: "success" };
        },
      },
      update: {
        service: "googlesheets",
        method: "PUT",
        async execute({ credentials, inputs }) {
          const { google } = require("googleapis");
          const authClient = new google.auth.OAuth2(
            credentials.clientId,
            credentials.secretId
          );
          authClient.setCredentials({ access_token: credentials.access_token });
          const sheets = google.sheets({ version: "v4", auth: authClient });
          const spreadsheetId = process.env.MY_SPREEDSHEET_ID;
          await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `Sheet1!A${Number(inputs.rowIndex) + 1}`,
            valueInputOption: "RAW",
            requestBody: { values: [inputs.valuesArray] },
          });
          return { status: "updated" };
        },
      },
      delete: {
        service: "googlesheets",
        method: "DELETE",
        async execute({ credentials, inputs }) {
          const { google } = require("googleapis");
          const authClient = new google.auth.OAuth2(
            credentials.clientId,
            credentials.secretId
          );
          authClient.setCredentials({ access_token: credentials.access_token });
          const sheets = google.sheets({ version: "v4", auth: authClient });
          const spreadsheetId = process.env.MY_SPREEDSHEET_ID;
          const sheetRowToDelete = Number(inputs.rowIndex) + 1;
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
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
          return { status: "deleted" };
        },
      },
    },
  },
};
