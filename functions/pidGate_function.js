// Cloud Function: one attempt per Prolific ID.
// Add this to functions/index.js of the Firebase project that hosts the /chat function (aiassist-exp), then deploy:
//     firebase deploy --only functions:pidGate --project aiassist-exp
// (v2 syntax, matching the /chat function. In index.js: exports.pidGate = require("./pidGate_function").pidGate;)
// The experiment page calls it twice:
//   mode "check": when the link opens, before the consent form. Reads only. If the ID is already claimed, the page shows
//                 "You have already participated" and stops (no condition is assigned, nothing is written).
//   mode "claim": when the participant agrees to the consent form. Writes <study>/participantIndex/<PID> once, atomically.
// To let someone retry (for example after a browser crash), delete <study>/participantIndex/<PID> in the Firebase console.
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();

const STUDY_OK = /^(aiAssistFractions[A-Za-z0-9_]*|tests)$/;   // the real study branches and the test branch
const PID_OK = /^[A-Za-z0-9_-]{1,64}$/;

exports.pidGate = onRequest({ cors: true, region: "us-central1", invoker: "public" }, async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const { study, pid, uid, mode } = body;
  if (!STUDY_OK.test(String(study)) || !PID_OK.test(String(pid)) || (mode !== "check" && mode !== "claim")) {
    return res.status(400).json({ error: "bad request" });
  }

  const ref = admin.database().ref(`${study}/participantIndex/${pid}`);
  try {
    if (mode === "check") {
      const snap = await ref.get();
      return res.json({ exists: snap.exists() });
    }
    const t = await ref.transaction((cur) => (cur ? undefined : { uid: String(uid || ""), claimedAt: admin.database.ServerValue.TIMESTAMP }));
    const val = t.snapshot.val();
    const mine = !t.committed && !!val && val.uid === String(uid || "");
    return res.json({ claimed: t.committed, exists: !t.committed, mine });
  } catch (e) {
    console.error("pidGate failed", e);
    return res.status(500).json({ error: "server error" });
  }
});