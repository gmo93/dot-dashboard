const express = require("express");
const fetch = require("node-fetch"); // npm i node-fetch@2

const app = express();
app.use(express.json());

// ---------- CONFIG ----------

const MONDAY_API_URL = "https://api.monday.com/v2";
const MONDAY_API_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjY5NDkwNTAzNCwiYWFpIjoxMSwidWlkIjoxMTE2OTc5MTUsImlhZCI6IjIwMjYtMDgtMTlUMTc6Mjg6MDQuMTg3WiIsInBlciI6Im1lOndyaXRlIiwiYWN0aWQiOjU0ODc4ODEsInJnbiI6InVzZTEifQ._yVmZexGCeAZCDNc2iE7YAE-RRyrNV1lPo4Udf3C40Y"; // set this in your env

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

// ---------- WEBHOOK ROUTE ----------

app.post("/webhook", async (req, res) => {
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
        const parentItemId = event.parentItemId;

        if (!parentItemId) {
            console.log("No parentItemId on event, skipping:", event.pulseId);
            return;
        }

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

// ---------- START SERVER ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Webhook server listening on port ${PORT}`);
});

// const express = require('express');
// const fetch = require('node-fetch'); // npm install node-fetch@2
// const app = express();
// app.use(express.json());

// // ---- Fill this in ----
// const API_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjY5NDkwNTAzNCwiYWFpIjoxMSwidWlkIjoxMTE2OTc5MTUsImlhZCI6IjIwMjYtMDgtMTlUMTc6Mjg6MDQuMTg3WiIsInBlciI6Im1lOndyaXRlIiwiYWN0aWQiOjU0ODc4ODEsInJnbiI6InVzZTEifQ._yVmZexGCeAZCDNc2iE7YAE-RRyrNV1lPo4Udf3C40Y';
// // -----------------------

// async function mondayApi(query) {
//     const res = await fetch('https://api.monday.com/v2', {
//         method: 'POST',
//         headers: {
//             'Authorization': API_TOKEN,
//             'Content-Type': 'application/json'
//         },
//         body: JSON.stringify({ query })
//     });
//     return res.json();
// }

// app.post('/webhook', async (req, res) => {
//     // Handshake — required for monday.com to activate the webhook
//     if (req.body.challenge) {
//         return res.json({ challenge: req.body.challenge });
//     }

//     const event = req.body.event;

//     // Ack immediately so monday.com doesn't retry/time out while we work
//     res.status(200).send('ok');

//     console.log('\n========== WEBHOOK RECEIVED ==========');
//     console.log('Type:', event?.type);
//     console.log('Raw event:\n', JSON.stringify(event, null, 2));
//     console.log('=======================================\n');

//     // Only bother querying monday.com if this looks like a subitem status change
//     if (event?.type !== 'update_column_value') {
//         console.log('Skipping API read — event type is not "update_column_value".\n');
//         return;
//     }

//     const parentItemId = event.parentItemId;
//     if (!parentItemId) {
//         console.log('Skipping API read — no parentItemId on this event (likely not a subitem).\n');
//         return;
//     }

//     // READ-ONLY query — pulls current group + all subitems + their column values
//     const query = `
//     query {
//       items (ids: [${parentItemId}]) {
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

//     try {
//         const result = await mondayApi(query);

//         if (result.errors) {
//             console.log('API returned errors:\n', JSON.stringify(result.errors, null, 2));
//             return;
//         }

//         console.log('---------- API READ RESULT ----------');
//         console.log(JSON.stringify(result.data, null, 2));
//         console.log('--------------------------------------\n');
//     } catch (err) {
//         console.error('API call failed:', err);
//     }
// });

// app.listen(3000, () => console.log('listening on 3000'));