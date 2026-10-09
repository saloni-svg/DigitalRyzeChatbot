// DigitalRyze chatbot lead receiver.
// Paste this into Extensions > Apps Script inside your leads Google Sheet.
// Then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).

const SECRET = "CHANGE_ME_TO_A_LONG_RANDOM_STRING"; // must match LEAD_WEBHOOK_SECRET on Vercel
const NOTIFY_EMAIL = "you@digitalryze.com";        // where new lead alerts are sent
const SHEET_NAME = "Leads";

const COLUMNS = [
  "Timestamp", "Name", "Email", "Phone", "Business", "Website", "Location",
  "Service", "Requirement", "Budget", "Visitor type", "Wants human",
  "Notes", "Page", "Session ID", "Transcript"
];

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.secret !== SECRET) return out("forbidden");

    // General alert email (for example, a hot lead).
    if (d.type === "alert") {
      MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: d.subject || "DigitalRyze chatbot alert", body: d.body || "" });
      return out("ok");
    }

    // A visitor wants to talk to a person right now.
    if (d.type === "handoff") {
      MailApp.sendEmail({
        to: NOTIFY_EMAIL,
        subject: "Live chat request: " + (d.name || "A website visitor") + " wants to talk to a person",
        body: [
          (d.name || "A website visitor") + " is waiting on the website chat and asked for a real person.",
          "",
          "Reason: " + (d.reason || ""),
          "Email: " + (d.email || ""),
          "Phone: " + (d.phone || ""),
          "Page: " + (d.page || ""),
          "",
          "Open the admin dashboard to accept or decline (the request waits about 2 minutes):",
          d.dashboard || "",
          "",
          "Conversation so far:",
          d.transcript || ""
        ].join("\n")
      });
      return out("ok");
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(COLUMNS);
      sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight("bold");
      sheet.setFrozenRows(1);
    }

    const row = [
      new Date(), d.name, d.email, d.phone, d.business, d.website, d.location,
      d.service, d.requirement, d.budget, d.visitor_type, d.wants_human ? "Yes" : "",
      d.notes, d.page, d.sessionId, d.transcript
    ].map(v => (v === undefined || v === null ? "" : v));
    sheet.appendRow(row);

    const subject = "New chatbot lead: " + (d.name || "Unknown") + (d.business ? " (" + d.business + ")" : "");
    const lines = [
      "Name: " + (d.name || ""),
      "Email: " + (d.email || ""),
      "Phone: " + (d.phone || ""),
      "Business: " + (d.business || ""),
      "Website: " + (d.website || ""),
      "Location: " + (d.location || ""),
      "Service: " + (d.service || ""),
      "Requirement: " + (d.requirement || ""),
      "Budget: " + (d.budget || ""),
      "Visitor type: " + (d.visitor_type || ""),
      "Wants a human: " + (d.wants_human ? "Yes" : "No"),
      "Notes: " + (d.notes || ""),
      "Page: " + (d.page || ""),
      "",
      "Conversation:",
      d.transcript || "",
      "",
      "Sheet: " + ss.getUrl()
    ];
    MailApp.sendEmail({
      to: NOTIFY_EMAIL,
      subject: subject,
      body: lines.join("\n"),
      replyTo: d.email || NOTIFY_EMAIL
    });

    return out("ok");
  } catch (err) {
    return out("error: " + err);
  }
}

function out(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
}
