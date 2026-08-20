// const express = require("express");
// const fetch = require("node-fetch"); // npm i node-fetch@2
// const rateLimit = require("express-rate-limit"); // npm i express-rate-limit

// const app = express();
// app.use(express.json());

// // ---------- CONFIG ----------

// const MONDAY_API_URL = "https://api.monday.com/v2";
// const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN; // set this in your env

// // Standard Monday board webhooks (create_webhook mutation) are NOT cryptographically
// // signed — that's only available if you build a full Monday app with a signing secret.
// // So instead, we protect this endpoint with a shared secret passed as a query param.
// // Generate a long random string (e.g. `openssl rand -hex 32`) and set it as an env var,
// // then register your webhook URL as: https://your-app.com/webhook?token=<that value>
// const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// if (!WEBHOOK_SECRET) {
//     console.warn(
//         "WARNING: WEBHOOK_SECRET is not set. Your /webhook endpoint is unprotected. " +
//         "Set WEBHOOK_SECRET in your environment and add ?token=<secret> to your Monday webhook URL."
//     );
// }

// // Column IDs from your board (from the payload you shared)
// const STEP_COLUMN_ID = "color_mm6a6zwe";   // "Step" grouping column on subitems
// const STATUS_COLUMN_ID = "color_mm6acb3";  // "Status" column on subitems (Done/Not Done)

// // Map each Step value to the actual Monday group_id it should live in.
// // Pulled from your "DOT Tracking Board" groups query.
// const STEP_TO_GROUP_ID = {
//     "Step 1": "group_title",       // Step 1: Project reaches service board at 75% to 90%
//     "Step 2": "group_mm671brq",    // Step 2: Project Won
//     "Step 3": "group_mm678den",    // Step 3: Pre-Go Live
//     "Step 4": "group_mm68wqck",    // Step 4: Live Execution of Project
//     "Step 5": "group_mm683mg7",    // Step 5: Closeout of DOT on projects
//     "Complete": "group_mm66nn09",  // Project's DOT is closed out
// };

// // Order matters — this defines "first incomplete step"
// const STEP_ORDER = ["Step 1", "Step 2", "Step 3", "Step 4", "Step 5"];

// // ---------- MONDAY API HELPERS ----------

// async function mondayApiCall(query) {
//     const res = await fetch(MONDAY_API_URL, {
//         method: "POST",
//         headers: {
//             "Content-Type": "application/json",
//             Authorization: MONDAY_API_TOKEN,
//         },
//         body: JSON.stringify({ query }),
//     });

//     const json = await res.json();
//     if (json.errors) {
//         console.error("Monday API error:", JSON.stringify(json.errors, null, 2));
//         throw new Error("Monday API request failed");
//     }
//     return json.data;
// }

// // Fetch the parent item, its current group, and all its subitems + column values
// async function fetchItemWithSubitems(itemId) {
//     const query = `
//     query {
//       items(ids: [${itemId}]) {
//         id
//         name
//         group {
//           id
//           title
//         }
//         subitems {
//           id
//           name
//           column_values {
//             id
//             text
//             type
//           }
//         }
//       }
//     }
//   `;

//     const data = await mondayApiCall(query);
//     return data.items[0];
// }

// async function moveItemToGroup(itemId, groupId) {
//     const mutation = `
//     mutation {
//       move_item_to_group(item_id: ${itemId}, group_id: "${groupId}") {
//         id
//       }
//     }
//   `;
//     await mondayApiCall(mutation);
// }

// // ---------- CORE LOGIC ----------

// // Groups subitems by their "Step" column value
// // -> { "Step 1": [subitem, subitem, ...], "Step 2": [...], ... }
// function groupByStep(subitems) {
//     const groups = {};
//     for (const sub of subitems) {
//         const stepCol = sub.column_values.find((c) => c.id === STEP_COLUMN_ID);
//         const step = stepCol?.text ?? "Unknown";
//         if (!groups[step]) groups[step] = [];
//         groups[step].push(sub);
//     }
//     return groups;
// }

// function isStepComplete(stepSubitems) {
//     if (!stepSubitems || stepSubitems.length === 0) return true; // no items in step = nothing blocking
//     return stepSubitems.every((sub) => {
//         const statusCol = sub.column_values.find((c) => c.id === STATUS_COLUMN_ID);
//         return statusCol?.text === "Done";
//     });
// }

// // Walks STEP_ORDER and returns the first step that has something undone.
// // If every step is complete, returns "Complete".
// function determineTargetStep(groupedSubitems) {
//     for (const step of STEP_ORDER) {
//         if (!isStepComplete(groupedSubitems[step])) {
//             return step;
//         }
//     }
//     return "Complete";
// }

// // ---------- SECURITY MIDDLEWARE ----------

// // Basic rate limiter: caps requests per IP to blunt floods/abuse.
// // Generous enough not to interfere with legitimate rapid status changes.
// const webhookLimiter = rateLimit({
//     windowMs: 60 * 1000, // 1 minute
//     max: 60,             // 60 requests per minute per IP
//     standardHeaders: true,
//     legacyHeaders: false,
//     message: { error: "Too many requests" },
// });

// // Rejects any request whose ?token= doesn't match WEBHOOK_SECRET.
// // The Monday "challenge" verification ping also has to pass this check,
// // so make sure your registered webhook URL includes ?token=... from the start.
// function requireWebhookSecret(req, res, next) {
//     if (!WEBHOOK_SECRET) return next(); // no secret configured — warning already logged at startup

//     const provided = req.query.token;
//     if (provided !== WEBHOOK_SECRET) {
//         console.warn("Rejected webhook request: invalid or missing token.");
//         return res.status(401).json({ error: "Unauthorized" });
//     }
//     next();
// }

// // Validates that the payload at least looks like a real Monday event before we act on it.
// function isValidMondayEvent(event) {
//     if (!event || typeof event !== "object") return false;
//     if (event.app !== "monday") return false;
//     if (typeof event.parentItemId !== "string" && typeof event.parentItemId !== "number") return false;
//     if (!/^\d+$/.test(String(event.parentItemId))) return false; // must look like a numeric Monday ID
//     return true;
// }

// // ---------- WEBHOOK ROUTE ----------

// app.post("/webhook", webhookLimiter, requireWebhookSecret, async (req, res) => {
//     const body = req.body;

//     // Monday sends a one-time "challenge" request when you first register the webhook URL.
//     // You must echo it back verbatim or the webhook registration will fail.
//     if (body.challenge) {
//         return res.status(200).json({ challenge: body.challenge });
//     }

//     // Respond fast — Monday expects a quick 200. Do the real work after responding
//     // so a slow Monday API call doesn't cause Monday to retry the webhook.
//     res.status(200).send("ok");

//     try {
//         const event = body.event ?? body; // handles both wrapped and raw event shapes

//         if (!isValidMondayEvent(event)) {
//             console.warn("Rejected malformed/unexpected payload:", JSON.stringify(body).slice(0, 300));
//             return;
//         }

//         const parentItemId = event.parentItemId;

//         const item = await fetchItemWithSubitems(parentItemId);
//         if (!item) {
//             console.error("Could not fetch item", parentItemId);
//             return;
//         }

//         const currentGroupId = item.group.id;
//         const grouped = groupByStep(item.subitems);
//         const targetStep = determineTargetStep(grouped);
//         const targetGroupId = STEP_TO_GROUP_ID[targetStep];

//         if (!targetGroupId) {
//             console.error(`No group_id configured for step "${targetStep}"`);
//             return;
//         }

//         if (currentGroupId === targetGroupId) {
//             console.log(`Item ${parentItemId} already in correct group (${targetStep}). No move needed.`);
//             return;
//         }

//         await moveItemToGroup(parentItemId, targetGroupId);
//         console.log(`Moved item ${parentItemId} to "${targetStep}" (group ${targetGroupId}).`);
//     } catch (err) {
//         console.error("Error handling webhook:", err);
//     }
// });

// // ---------- HEALTH CHECK ----------

// // Unprotected on purpose — safe to ping from an uptime monitor.
// // Keeps the /webhook path reserved for actual Monday traffic.
// app.get("/health", (req, res) => {
//     res.status(200).send("ok");
// });

// // ---------- START SERVER ----------

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//     console.log(`Webhook server listening on port ${PORT}`);
// });

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

// ---------- DATE MATH ----------

function isWeekend(date) {
    const day = date.getDay();
    return day === 0 || day === 6;
}

// Move backward N business days from a date (skipping weekends)
function subtractBusinessDays(date, days) {
    const result = new Date(date);
    let remaining = days;
    while (remaining > 0) {
        result.setDate(result.getDate() - 1);
        if (!isWeekend(result)) remaining--;
    }
    return result;
}

// Trailing window of business days ending at anchorDate (inclusive),
// chronological order (earliest first, anchorDate last).
function getBusinessDayWindow(anchorDate, windowSize = 5) {
    const days = [];
    let cursor = new Date(anchorDate);
    while (days.length < windowSize) {
        if (!isWeekend(cursor)) days.push(new Date(cursor));
        cursor.setDate(cursor.getDate() - 1);
    }
    return days.reverse();
}

// Assigns due dates to a list of items (in order), counting backward from
// anchorDate one business day per item. If there are more items than business
// days in the window, extra items double up on the earliest day rather than
// spilling into the prior week.
function assignDueDates(items, anchorDate, windowSize = 5) {
    const window = getBusinessDayWindow(anchorDate, windowSize);
    const n = items.length;
    const dates = new Array(n);
    let dayIndex = window.length - 1;

    for (let i = n - 1; i >= 0; i--) {
        dates[i] = window[dayIndex];
        if (dayIndex > 0) dayIndex--;
    }
    return dates;
}

function toMondayDateString(date) {
    return date.toISOString().split("T")[0]; // "YYYY-MM-DD"
}

// ---------- SUBITEM TEMPLATES ----------

// Edit this list directly to change subitem text — no digging through
// Monday's automation UI. "step" controls both the Step tag and which
// due-date anchor (below) applies. Steps 4 and 5 get no due date.
const SUBITEM_TEMPLATES = [
    { name: 'Is DOT Needed for this project? Set "DOT Needed" status to "Needed" or "Not Needed"', step: "Step 1" },
    { name: 'Ask Antonietta who is on the project team, and fill in "Project Team" column', step: "Step 1" },
    { name: "Put DOT Guideline Checklist in Project Ops Tab", step: "Step 1" },
    { name: "Send DOT Ops Team email to Project team with one pagers, links, Humphreys connect, etc.", step: "Step 1" },
    { name: "Retrieve final vehicle info, final routing, and driver info from the project team", step: "Step 2" },
    { name: "Submit final vehicle & driver info to Humphrey", step: "Step 2" },
    { name: "Email driver Driver Preparation Materials, and make sure they acknowledge they have received, and have read through", step: "Step 2" },
    { name: "Execute all vehicle based inspections, services, or maintenance required for compliance", step: "Step 2" },
    { name: "Email Humphreys to do final review for compliance, and work through any flags", step: "Step 2" },
    { name: "Get DOT kit to driver", step: "Step 2" },
    { name: "Account teams & DOT Operations team executes full driver DOT training", step: "Step 3" },
    { name: "Have Driver sign off on process, training, materials, and responsibilities", step: "Step 3" },
    { name: "Operations Team weekly ping to Accounts Team for DOT touch base?", step: "Step 3" },
    { name: "Operations Team weekly ping to Accounts Team for DOT touch base?", step: "Step 4" },
    { name: "Operations Team weekly meeting with JL to get Humphrey's update and share Accounts Team updates", step: "Step 5" },
    { name: "Have producer & project team fill-out driver close-out form", step: "Step 5" },
];

// Business-day offset (back from Live Date) that anchors each step's LAST task.
// Steps not listed here get no due date.
const STEP_ANCHOR_BUSINESS_DAYS = {
    "Step 1": 20, // 4 weeks
    "Step 2": 10, // 2 weeks
    "Step 3": 5,  // 1 business week
};

const PARENT_LIVE_DATE_COLUMN_ID = "date_mm6b6ehm"; // "First Live Date" on the parent item
const PARENT_DOT_NEEDED_COLUMN_ID = "color_mm66ymna"; // "DOT Needed?" on the parent item — the trigger column
const SUBITEM_DATE_COLUMN_ID = "date_mm6b8ye0";      // date column on each subitem
const SUBITEM_STEP_COLUMN_ID = STEP_COLUMN_ID;        // reuse — "Step" status column

// Builds the due-date map: template index -> Date (or null for Step 4/5)
function buildDueDates(templates, liveDate) {
    const byStep = {};
    templates.forEach((t, i) => {
        if (!byStep[t.step]) byStep[t.step] = [];
        byStep[t.step].push(i);
    });

    const dueDates = new Array(templates.length).fill(null);

    for (const [step, indices] of Object.entries(byStep)) {
        const offset = STEP_ANCHOR_BUSINESS_DAYS[step];
        if (offset == null) continue; // Step 4/5 — no due date

        const anchor = subtractBusinessDays(liveDate, offset);
        const stepItems = indices.map((i) => templates[i]);
        const stepDates = assignDueDates(stepItems, anchor);

        indices.forEach((templateIndex, j) => {
            dueDates[templateIndex] = stepDates[j];
        });
    }

    return dueDates;
}

// ---------- SUBITEM CREATION ----------

async function createSubitem(parentItemId, template, dueDate) {
    const columnValues = {
        [SUBITEM_STEP_COLUMN_ID]: { label: template.step },
    };
    if (dueDate) {
        columnValues[SUBITEM_DATE_COLUMN_ID] = { date: toMondayDateString(dueDate) };
    }

    // Escape quotes for safe embedding in the GraphQL string literal
    const escapedName = template.name.replace(/"/g, '\\"');
    const escapedColumnValues = JSON.stringify(columnValues).replace(/"/g, '\\"');

    const mutation = `
    mutation {
      create_subitem(
        parent_item_id: ${parentItemId},
        item_name: "${escapedName}",
        column_values: "${escapedColumnValues}"
      ) {
        id
      }
    }
  `;
    await mondayApiCall(mutation);
}

async function generateAllSubitems(parentItemId, liveDate) {
    // liveDate may be null — if so, create subitems with no due dates.
    // Dates get backfilled later by the /webhook/backfill-due-dates route.
    const dueDates = liveDate
        ? buildDueDates(SUBITEM_TEMPLATES, liveDate)
        : new Array(SUBITEM_TEMPLATES.length).fill(null);

    for (let i = 0; i < SUBITEM_TEMPLATES.length; i++) {
        await createSubitem(parentItemId, SUBITEM_TEMPLATES[i], dueDates[i]);
    }
}

// Matches existing subitems to templates by (name, step) pair so we can
// backfill due dates onto the correct subitem later. Some template names
// repeat (e.g. "Operations Team weekly ping..." appears in both Step 3 and
// Step 4), so name alone isn't a safe key — name + step together is unique.
function matchSubitemsToTemplates(subitems, templates) {
    const remaining = [...subitems];
    return templates.map((t) => {
        const idx = remaining.findIndex((s) => {
            const stepText = s.column_values.find((c) => c.id === STEP_COLUMN_ID)?.text;
            return s.name === t.name && stepText === t.step;
        });
        if (idx === -1) return null;
        const [matched] = remaining.splice(idx, 1);
        return matched;
    });
}

async function updateSubitemDueDate(subitemId, subitemBoardId, dueDate) {
    const valueJson = JSON.stringify({ date: toMondayDateString(dueDate) }).replace(/"/g, '\\"');
    const mutation = `
    mutation {
      change_column_value(
        item_id: ${subitemId},
        board_id: ${subitemBoardId},
        column_id: "${SUBITEM_DATE_COLUMN_ID}",
        value: "${valueJson}"
      ) {
        id
      }
    }
  `;
    await mondayApiCall(mutation);
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
// itemIdField lets each route specify which field carries the relevant item id
// ("parentItemId" for subitem-level events, "pulseId" for parent-item-level events).
function isValidMondayEvent(event, itemIdField = "parentItemId") {
    if (!event || typeof event !== "object") return false;
    if (event.app !== "monday") return false;
    const id = event[itemIdField];
    if (typeof id !== "string" && typeof id !== "number") return false;
    if (!/^\d+$/.test(String(id))) return false; // must look like a numeric Monday ID
    return true;
}

// ---------- WEBHOOK ROUTE: STATUS-BASED GROUP MOVER ----------

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

// ---------- WEBHOOK ROUTE: SUBITEM GENERATOR ----------

// Fires when "DOT Needed?" changes to "Needed" on the parent item.
// Pulls the parent's First Live Date, computes due dates per SUBITEM_TEMPLATES
// and STEP_ANCHOR_BUSINESS_DAYS, then creates all 15 subitems.
app.post("/webhook/generate-subitems", webhookLimiter, requireWebhookSecret, async (req, res) => {
    const body = req.body;

    if (body.challenge) {
        return res.status(200).json({ challenge: body.challenge });
    }

    res.status(200).send("ok");

    try {
        const event = body.event ?? body;

        if (!isValidMondayEvent(event, "pulseId")) {
            console.warn("Rejected malformed/unexpected payload:", JSON.stringify(body).slice(0, 300));
            return;
        }

        // For this trigger, the item that changed IS the parent item (no subitem involved yet).
        const parentItemId = event.pulseId;
        if (!parentItemId) {
            console.warn("No item id on event, skipping.");
            return;
        }

        // Only proceed if this event is for the "DOT Needed?" column specifically
        if (event.columnId !== PARENT_DOT_NEEDED_COLUMN_ID) {
            console.log(`Ignoring change on column "${event.columnId}" — not the DOT Needed? column.`);
            return;
        }

        // Only proceed if this change actually set the status to "Needed"
        const newLabel = event.value?.label?.text;
        if (newLabel !== "Needed") {
            console.log(`Ignoring change to "${newLabel}" — not a "Needed" transition.`);
            return;
        }

        // Pull the parent item's First Live Date, and check whether subitems already exist
        const query = `
      query {
        items(ids: [${parentItemId}]) {
          column_values(ids: ["${PARENT_LIVE_DATE_COLUMN_ID}"]) {
            text
          }
          subitems {
            id
          }
        }
      }
    `;
        const data = await mondayApiCall(query);
        const item = data.items[0];

        if (item?.subitems?.length > 0) {
            console.log(
                `Item ${parentItemId} already has ${item.subitems.length} subitem(s) — skipping generation to avoid duplicates.`
            );
            return;
        }

        const liveDateText = item?.column_values[0]?.text;
        const liveDate = liveDateText ? new Date(liveDateText) : null;

        await generateAllSubitems(parentItemId, liveDate);
        console.log(
            liveDate
                ? `Generated ${SUBITEM_TEMPLATES.length} subitems with due dates for item ${parentItemId}.`
                : `Generated ${SUBITEM_TEMPLATES.length} subitems (no due dates — First Live Date not set yet) for item ${parentItemId}.`
        );
    } catch (err) {
        console.error("Error handling subitem-generation webhook:", err);
    }
});

// ---------- WEBHOOK ROUTE: DUE-DATE BACKFILL ----------

// Fires when "First Live Date" changes on the parent item. Re-fetches the
// authoritative current value (never trusts the webhook payload's date shape
// directly), recalculates due dates, and writes them onto the matching
// already-created subitems. Safe to fire repeatedly — e.g. if Live Date gets
// corrected later, this just recalculates and overwrites again.
app.post("/webhook/backfill-due-dates", webhookLimiter, requireWebhookSecret, async (req, res) => {
    const body = req.body;

    if (body.challenge) {
        return res.status(200).json({ challenge: body.challenge });
    }

    res.status(200).send("ok");

    try {
        const event = body.event ?? body;

        if (!isValidMondayEvent(event, "pulseId")) {
            console.warn("Rejected malformed/unexpected payload:", JSON.stringify(body).slice(0, 300));
            return;
        }

        if (event.columnId !== PARENT_LIVE_DATE_COLUMN_ID) {
            console.log(`Ignoring change on column "${event.columnId}" — not First Live Date.`);
            return;
        }

        const parentItemId = event.pulseId;

        // Pull authoritative current Live Date + all subitems (with step tags + board id)
        const query = `
      query {
        items(ids: [${parentItemId}]) {
          column_values(ids: ["${PARENT_LIVE_DATE_COLUMN_ID}"]) {
            text
          }
          subitems {
            id
            name
            board {
              id
            }
            column_values {
              id
              text
            }
          }
        }
      }
    `;
        const data = await mondayApiCall(query);
        const item = data.items[0];
        const liveDateText = item?.column_values[0]?.text;

        if (!liveDateText) {
            console.log(`Item ${parentItemId}: First Live Date was cleared — leaving existing subitem dates as-is.`);
            return;
        }

        const liveDate = new Date(liveDateText);
        const dueDates = buildDueDates(SUBITEM_TEMPLATES, liveDate);
        const matchedSubitems = matchSubitemsToTemplates(item.subitems, SUBITEM_TEMPLATES);

        let updated = 0;
        let skipped = 0;

        for (let i = 0; i < SUBITEM_TEMPLATES.length; i++) {
            const dueDate = dueDates[i];
            const subitem = matchedSubitems[i];

            if (!dueDate) continue; // Step 4/5 — no date to set
            if (!subitem) {
                console.warn(`No matching subitem found for template: "${SUBITEM_TEMPLATES[i].name}" (${SUBITEM_TEMPLATES[i].step})`);
                skipped++;
                continue;
            }

            await updateSubitemDueDate(subitem.id, subitem.board.id, dueDate);
            updated++;
        }

        console.log(`Backfilled due dates for item ${parentItemId}: ${updated} updated, ${skipped} skipped (no match).`);
    } catch (err) {
        console.error("Error handling due-date backfill webhook:", err);
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