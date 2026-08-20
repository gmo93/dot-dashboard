const express = require("express");
const fetch = require("node-fetch"); // npm i node-fetch@2
const rateLimit = require("express-rate-limit"); // npm i express-rate-limit

const app = express();
app.use(express.json());

// ---------- CONFIG ----------

const MONDAY_API_URL = "https://api.monday.com/v2";
const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN; // set this in your env

// Standard Monday board webhooks (create_webhook mutation) are NOT cryptographically
// signed — that's only available if you build a full Monday app with a signing secret.
// So instead, we protect this endpoint with a shared secret passed as a query param.
// Generate a long random string (e.g. `openssl rand -hex 32`) and set it as an env var,
// then register your webhook URL as: https://your-app.com/webhook?token=<that value>
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!WEBHOOK_SECRET) {
    console.warn(
        "WARNING: WEBHOOK_SECRET is not set. Your /webhook endpoint is unprotected. " +
        "Set WEBHOOK_SECRET in your environment and add ?token=<secret> to your Monday webhook URL."
    );
}

// Column IDs from your board (from the payload you shared)
const STEP_COLUMN_ID = "color_mm6a6zwe";   // "Step" grouping column on subitems
const STATUS_COLUMN_ID = "color_mm6acb3";  // "Status" column on subitems (Done/Not Done)

// Map each Step value to the actual Monday group_id it should live in.
// Pulled from your "DOT Tracking Board" groups query.
const STEP_TO_GROUP_ID = {
    "Step 1": "group_title",       // Step 1: Project reaches service board at 75% to 90%
    "Step 2": "group_mm671brq",    // Step 2: Project Won
    "Step 3": "group_mm678den",    // Step 3: Pre-Go Live
    "Step 4": "group_mm68wqck",    // Step 4: Live Execution of Project
    "Step 5": "group_mm683mg7",    // Step 5: Closeout of DOT on projects
    "Complete": "group_mm66nn09",  // Project's DOT is closed out
};

// Order matters — this defines "first incomplete step"
const STEP_ORDER = ["Step 1", "Step 2", "Step 3", "Step 4", "Step 5"];

// ---------- MONDAY API HELPERS ----------

async function mondayApiCall(query) {
    const res = await fetch(MONDAY_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: MONDAY_API_TOKEN,
        },
        body: JSON.stringify({ query }),
    });

    const json = await res.json();
    if (json.errors) {
        console.error("Monday API error:", JSON.stringify(json.errors, null, 2));
        throw new Error("Monday API request failed");
    }
    return json.data;
}

// Fetch the parent item, its current group, and all its subitems + column values
async function fetchItemWithSubitems(itemId) {
    const query = `
    query {
      items(ids: [${itemId}]) {
        id
        name
        group {
          id
          title
        }
        subitems {
          id
          name
          column_values {
            id
            text
            type
          }
        }
      }
    }
  `;

    const data = await mondayApiCall(query);
    return data.items[0];
}

async function moveItemToGroup(itemId, groupId) {
    const mutation = `
    mutation {
      move_item_to_group(item_id: ${itemId}, group_id: "${groupId}") {
        id
      }
    }
  `;
    await mondayApiCall(mutation);
}

// ---------- CORE LOGIC ----------

// Groups subitems by their "Step" column value
// -> { "Step 1": [subitem, subitem, ...], "Step 2": [...], ... }
function groupByStep(subitems) {
    const groups = {};
    for (const sub of subitems) {
        const stepCol = sub.column_values.find((c) => c.id === STEP_COLUMN_ID);
        const step = stepCol?.text ?? "Unknown";
        if (!groups[step]) groups[step] = [];
        groups[step].push(sub);
    }
    return groups;
}

function isStepComplete(stepSubitems) {
    if (!stepSubitems || stepSubitems.length === 0) return true; // no items in step = nothing blocking
    return stepSubitems.every((sub) => {
        const statusCol = sub.column_values.find((c) => c.id === STATUS_COLUMN_ID);
        return statusCol?.text === "Done";
    });
}

// Walks STEP_ORDER and returns the first step that has something undone.
// If every step is complete, returns "Complete".
function determineTargetStep(groupedSubitems) {
    for (const step of STEP_ORDER) {
        if (!isStepComplete(groupedSubitems[step])) {
            return step;
        }
    }
    return "Complete";
}

// ---------- SECURITY MIDDLEWARE ----------

// Basic rate limiter: caps requests per IP to blunt floods/abuse.
// Generous enough not to interfere with legitimate rapid status changes.
const webhookLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60,             // 60 requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests" },
});

// Rejects any request whose ?token= doesn't match WEBHOOK_SECRET.
// The Monday "challenge" verification ping also has to pass this check,
// so make sure your registered webhook URL includes ?token=... from the start.
function requireWebhookSecret(req, res, next) {
    if (!WEBHOOK_SECRET) return next(); // no secret configured — warning already logged at startup

    const provided = req.query.token;
    if (provided !== WEBHOOK_SECRET) {
        console.warn("Rejected webhook request: invalid or missing token.");
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
}

// Validates that the payload at least looks like a real Monday event before we act on it.
function isValidMondayEvent(event) {
    if (!event || typeof event !== "object") return false;
    if (event.app !== "monday") return false;
    if (typeof event.parentItemId !== "string" && typeof event.parentItemId !== "number") return false;
    if (!/^\d+$/.test(String(event.parentItemId))) return false; // must look like a numeric Monday ID
    return true;
}

// ---------- WEBHOOK ROUTE ----------

app.post("/webhook", webhookLimiter, requireWebhookSecret, async (req, res) => {
    const body = req.body;

    // Monday sends a one-time "challenge" request when you first register the webhook URL.
    // You must echo it back verbatim or the webhook registration will fail.
    if (body.challenge) {
        return res.status(200).json({ challenge: body.challenge });
    }

    // Respond fast — Monday expects a quick 200. Do the real work after responding
    // so a slow Monday API call doesn't cause Monday to retry the webhook.
    res.status(200).send("ok");

    try {
        const event = body.event ?? body; // handles both wrapped and raw event shapes

        if (!isValidMondayEvent(event)) {
            console.warn("Rejected malformed/unexpected payload:", JSON.stringify(body).slice(0, 300));
            return;
        }

        const parentItemId = event.parentItemId;

        const item = await fetchItemWithSubitems(parentItemId);
        if (!item) {
            console.error("Could not fetch item", parentItemId);
            return;
        }

        const currentGroupId = item.group.id;
        const grouped = groupByStep(item.subitems);
        const targetStep = determineTargetStep(grouped);
        const targetGroupId = STEP_TO_GROUP_ID[targetStep];

        if (!targetGroupId) {
            console.error(`No group_id configured for step "${targetStep}"`);
            return;
        }

        if (currentGroupId === targetGroupId) {
            console.log(`Item ${parentItemId} already in correct group (${targetStep}). No move needed.`);
            return;
        }

        await moveItemToGroup(parentItemId, targetGroupId);
        console.log(`Moved item ${parentItemId} to "${targetStep}" (group ${targetGroupId}).`);
    } catch (err) {
        console.error("Error handling webhook:", err);
    }
});

// ---------- HEALTH CHECK ----------

// Unprotected on purpose — safe to ping from an uptime monitor.
// Keeps the /webhook path reserved for actual Monday traffic.
app.get("/health", (req, res) => {
    res.status(200).send("ok");
});

// ---------- START SERVER ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Webhook server listening on port ${PORT}`);
});
