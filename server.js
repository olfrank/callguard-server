require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const app = express();
const axios = require("axios");

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN || process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_ELECTRICIANS_TABLE = process.env.AIRTABLE_ELECTRICIANS_TABLE || "Electricians List";
const AIRTABLE_LOG_TABLE = process.env.AIRTABLE_LOG_TABLE || "Missed Calls Log";

function airtableUrl(tableName) {
  return `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`;
}

const airtable = axios.create({
  headers: {
    Authorization: `Bearer ${AIRTABLE_TOKEN}`,
    "Content-Type": "application/json",
  },
  timeout: 15000,
});

function normE164(n = "") {
  return String(n).replace(/\s+/g, "").trim();
}


function escapeAirtableValue(v="") {
  return String(v).replace(/"/g, '\\"');
}

function safeLower(s = "") {
  return String(s || "").trim().toLowerCase();
}

async function getElectricianByTwilioNumber(toTwilioNumber) {
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) throw new Error("Airtable not configured");

  const to = normE164(toTwilioNumber);
  const formula = `{Twilio Number} = "${escapeAirtableValue(to)}"`;

  const resp = await airtable.get(airtableUrl(AIRTABLE_ELECTRICIANS_TABLE), {
    params: { filterByFormula: formula, maxRecords: 1 },
  });

  const record = resp.data?.records?.[0];
  if (!record) return null;

  return { recordId: record.id, ...record.fields };
}

async function logMissedCall(fields) {
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
    console.log("Airtable not configured - skipping log");
    return;
  }

  try {
    console.log("Logging to Airtable table:", AIRTABLE_LOG_TABLE);
    const resp = await airtable.post(airtableUrl(AIRTABLE_LOG_TABLE), {
      records: [{ fields }],
    });
    console.log("Airtable log created:", resp.data?.records?.[0]?.id);
  } catch (err) {
    console.error("Airtable write FAILED:", err?.response?.status, err?.response?.data || err.message);
    throw err; // important while debugging
  }
}

async function alreadyProcessed(messageSid) {
  // optional idempotency to avoid double-processing if Twilio retries
  const formula = `{MessageSid} = "${escapeAirtableValue(messageSid)}"`;
  const resp = await airtable.get(airtableUrl(AIRTABLE_LOG_TABLE), {
    params: { filterByFormula: formula, maxRecords: 1 },
  });
  return (resp.data?.records?.length || 0) > 0;
}

app.get("/debug/airtable-fields", async (req, res) => {
  try {
    const url = `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`;
    const meta = await airtable.get(url);

    const table = meta.data.tables.find(
      (t) => t.name === AIRTABLE_LOG_TABLE
    );

    if (!table) {
      return res.status(404).json({
        error: "Table not found in base meta",
        lookingFor: AIRTABLE_LOG_TABLE,
        availableTables: meta.data.tables.map((t) => t.name),
      });
    }

    return res.json({
      table: table.name,
      fields: table.fields.map((f) => ({
        name: f.name,
        type: f.type,
      })),
    });
  } catch (err) {
    return res.status(500).json({
      error: err?.response?.data || err.message,
    });
  }
});

  
// Twilio sends application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
(async () => {
    try {
      const acc = await client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
      console.log("Twilio auth OK for:", acc.friendlyName);
    } catch (e) {
      console.error("Twilio auth FAILED:", e.status, e.code, e.message);
    }
  })();
// ---- Helpers ----

// More robust urgency detection
function detectUrgency(text = "") {
  const t = text.toLowerCase();

  // Strong signals
  if (/\b(urgent|asap|emergency|danger|sparking|burning|smell of gas|fire|leak)\b/.test(t)) return "Urgent";
  if (/\b(today|now|tonight|immediately|straight away)\b/.test(t)) return "Needed today";
  if (/\b(quote|estimate|price|cost|how much)\b/.test(t)) return "Quote";

  // If they responded "1/2/3" from your triage prompt
  const n = (t.match(/\b[123]\b/) || [])[0];
  if (n === "1") return "Urgent";
  if (n === "2") return "Needed today";
  if (n === "3") return "Quote";

  return "General";
}


function buildLogFields({
  messageSid,
  fromCustomer,
  toTwilioNumber,
  electricianRecordId, // optional
  electricianId,       // optional
  businessName,        // optional
  reply,
  urgency,
  postcode,
  alertSent,
  alertChannel,
  customerConfirmationSent,
  notes,
  replyReceived = true,
}) {
  return {
    "Customer Number": fromCustomer,
    "Electrician": electricianRecordId ? [electricianRecordId] : [],

    // "Call Time": new Date().toISOString(),

    "Alert Sent": !!alertSent,
    "Reply Received": !!replyReceived,

    "Notes": notes || "",

    // "Electrician Business Name": businessName || "",
    
    // "Electrician Twilio Number": toTwilioNumber,
    
    
    
    "Customer Message": reply || "",
    "Urgency": urgency || "General",
    "Postcode": postcode || "Unknown",
    
    "Alert Channel": alertChannel || "",
    "Customer Confirmation Sent": !!customerConfirmationSent,
    
    // Optional if you have these columns (otherwise remove them):
    
    "MessageSid": messageSid || "unknown",
  };
}


// UK postcode extraction (common practical regex)
// Works with: SW1A 1AA, SW1A1AA, M1 1AE, B33 8TH, etc.
function extractUKPostcode(text = "") {
  const t = text.toUpperCase().replace(/\s+/g, " ").trim();

  const re =
    /\b([A-Z]{1,2}\d[A-Z\d]?)\s?(\d[A-Z]{2})\b/;

  const m = t.match(re);
  if (!m) return "Unknown";

  // Normalize spacing: "SW1A 1AA"
  return `${m[1]} ${m[2]}`;
}

// If they don’t provide a postcode, we still forward the raw reply
function cleanReply(text = "") {
  return text.trim().slice(0, 500); // keep it short
}

// ---- Webhook ----

// Optional but recommended: validate Twilio signature
// IMPORTANT: set this to your EXACT public URL in Twilio (ngrok URL + /sms)
const WEBHOOK_URL = process.env.TWILIO_WEBHOOK_URL;

// app.use((req, res, next) => {
//     console.log("INCOMING:", req.method, req.path);
//     console.log("Headers:", {
//       host: req.headers.host,
//       "x-twilio-signature": req.headers["x-twilio-signature"],
//     });
//     next();
//   });

const validateTwilio = twilio.webhook({
  validate: true,
  url: WEBHOOK_URL,
  authToken: process.env.TWILIO_AUTH_TOKEN,
});
app.post("/sms", validateTwilio, async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  const fromCustomer = req.body.From;
  const toTwilioNumber = req.body.To;
  const body = req.body.Body || "";
  const messageSid = req.body.MessageSid;

  const reply = cleanReply(body);
  const urgency = detectUrgency(body);
  const postcode = extractUKPostcode(body);

  try {
    if (messageSid && AIRTABLE_TOKEN && (await alreadyProcessed(messageSid))) {
      return res.status(200).type("text/xml").send(twiml.toString());
    }

    const electrician = await getElectricianByTwilioNumber(toTwilioNumber);

    if (!electrician) {
      await logMissedCall(
        buildLogFields({
          messageSid,
          fromCustomer,
          toTwilioNumber,
          reply,
          urgency,
          replyReceived: true,
          postcode,
          alertSent: false,
          alertChannel: "",
          customerConfirmationSent: false,
          notes: `No electrician matched Twilio Number ${toTwilioNumber}`,
        })
      );
      return res.status(200).type("text/xml").send(twiml.toString());
    }

    const businessName = electrician["Business Name"] || "New enquiry";
    const preferredChannelRaw = electrician["Preferred Alert Channel"] || "WhatsApp";
    const preferredChannel = safeLower(preferredChannelRaw);

    const electricianWhatsAppRaw = electrician["WhatsApp Number"];
    const electricianSmsNumber = electrician["Electrician Mobile"];
    const electricianID = electrician["Electrician ID"];

    const waFrom = process.env.WHATSAPP_FROM;
    const alertTemplateSid = process.env.TEMPLATE_SID;

    const contentVariables = {
      1: fromCustomer,
      2: reply,
      3: postcode === "Unknown" ? "Area not provided" : postcode,
      4: urgency,
    };

    let alertSent = false;
    let alertChannel = "";

    if (preferredChannel === "whatsapp") {
      if (!electricianWhatsAppRaw || !alertTemplateSid || !waFrom) {
        throw new Error("Missing WhatsApp config (WhatsApp Number / TEMPLATE_SID / WHATSAPP_FROM)");
      }

      const electricianWhatsApp = electricianWhatsAppRaw.startsWith("whatsapp:")
        ? electricianWhatsAppRaw
        : `whatsapp:${electricianWhatsAppRaw}`;

      await client.messages.create({
        from: waFrom,
        to: electricianWhatsApp,
        contentSid: alertTemplateSid,
        contentVariables: JSON.stringify(contentVariables),
      });

      alertSent = true;
      alertChannel = "WhatsApp";
    } else {
      if (!electricianSmsNumber) throw new Error("Preferred SMS but Electrician Mobile missing");

      const smsText =
        `New missed call enquiry\n` +
        `From: ${fromCustomer}\n` +
        `Msg: "${reply}"\n` +
        `Loc: ${postcode === "Unknown" ? "Not provided" : postcode}\n` +
        `Urgency: ${urgency}`;

      await client.messages.create({
        from: toTwilioNumber,
        to: electricianSmsNumber,
        body: smsText,
      });

      alertSent = true;
      alertChannel = "SMS";
    }

    // Only confirm once alert succeeded
    await client.messages.create({
      from: toTwilioNumber,
      to: fromCustomer,
      body: `Thanks — got it. ${businessName} will be in touch shortly.`,
    });
    

    await logMissedCall(
      buildLogFields({
        messageSid,
        fromCustomer,
        toTwilioNumber,
        electricianRecordId: electrician.recordId,
        electricianId: electricianID,
        businessName,
        reply,
        urgency,
        postcode,
        alertSent,
        alertChannel,
        customerConfirmationSent: true,
        notes: `Preferred=${preferredChannelRaw}`,
      })
    );

    return res.status(200).type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("Webhook error:", err?.response?.data || err);

    try {
      await logMissedCall(
        buildLogFields({
          messageSid,
          fromCustomer,
          toTwilioNumber,
          reply,
          urgency,
          postcode,
          alertSent: false,
          alertChannel: "",
          customerConfirmationSent: false,
          notes: `ERROR: ${err?.message || "unknown"}`,
        })
      );
    } catch (encouragesilence) {}

    return res.status(200).type("text/xml").send(twiml.toString());
  }
});

// Health check (useful for testing)
app.get("/", (req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));