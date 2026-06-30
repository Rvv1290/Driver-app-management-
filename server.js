// ─────────────────────────────────────────────────────────────────────────────
//  RVIP Admin Backend
// ─────────────────────────────────────────────────────────────────────────────
//
//  Express server that exposes a small REST API for the admin HTML to
//  manage the driver app. Uses a Firebase service account so admin
//  writes bypass all Firestore security rules — this keeps your live
//  webapp's rules completely untouched.
//
//  Endpoints provided:
//    GET  /api/drivers                       — list all drivers
//    GET  /api/drivers/:id                   — one driver + their docs
//    POST /api/drivers/:id/verify            — flip isVerified
//    POST /api/drivers/:id/suspend           — flip isActive
//    POST /api/drivers/:id/docs/:type/approve
//    POST /api/drivers/:id/docs/:type/reject — { reason }
//    GET  /api/drivers/:id/payouts/:week     — weekly payout total
//    POST /api/drivers/:id/payouts/:week/mark-paid — { amount, method, note }
//    GET  /api/payouts/pending               — every driver's current week
//
//  Run with:    SERVICE_ACCOUNT_KEY=./seacoast-admin-key.json npm start
//  Or set:      GOOGLE_APPLICATION_CREDENTIALS env var
//  Or for Render/Railway:  paste the JSON into SERVICE_ACCOUNT_KEY_JSON env
//

import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { readFileSync } from "fs";
import "dotenv/config";

// ── Auth via service account ────────────────────────────────────────────────
let credential;
if (process.env.SERVICE_ACCOUNT_KEY_JSON) {
  // Hosted (Render/Railway/Vercel) — paste JSON into env var
  credential = admin.credential.cert(JSON.parse(process.env.SERVICE_ACCOUNT_KEY_JSON));
} else if (process.env.SERVICE_ACCOUNT_KEY) {
  // Local dev — path to JSON file
  credential = admin.credential.cert(JSON.parse(readFileSync(process.env.SERVICE_ACCOUNT_KEY, "utf8")));
} else {
  // ADC fallback (gcloud auth application-default login)
  credential = admin.credential.applicationDefault();
}

admin.initializeApp({
  credential,
  projectId: "seacoast-rip",
  storageBucket: "seacoast-rip.firebasestorage.app",
});

const db = admin.firestore();
const bucket = admin.storage().bucket();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

// ── Express setup ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cors({
  // ⚠️ Lock this down to your admin frontend domain in production.
  // For local dev, "*" is fine.
  origin: process.env.ADMIN_ORIGIN || "*",
}));

// ── Serve the admin frontend (public/) ──────────────────────────────────────
// Anything in public/ is served directly. The Sign-In page is at /,
// and the JS in it calls /api/* with the token in localStorage.
app.use(express.static("public"));

// Public health check — no auth required.
app.get("/healthz", (_, res) => res.json({ ok: true }));

// ── Auth gate for /api/* only ──────────────────────────────────────────────
// The static HTML page itself is publicly viewable (just a sign-in form),
// but every API call requires the bearer token.
app.use("/api", (req, res, next) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!process.env.ADMIN_API_TOKEN) {
    console.warn("⚠️ ADMIN_API_TOKEN not set — backend is OPEN. Set this env var before deploying.");
    return next();
  }
  if (token !== process.env.ADMIN_API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ────────────────────────────────────────────────────────────────────────────
//  Drivers
// ────────────────────────────────────────────────────────────────────────────

app.get("/api/drivers", async (_req, res) => {
  try {
    const snap = await db.collection("drivers").get();
    const drivers = snap.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    }));
    res.json({ drivers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/drivers/:id", async (req, res) => {
  try {
    const ref = db.collection("drivers").doc(req.params.id);
    const [driverSnap, docsSnap] = await Promise.all([
      ref.get(),
      ref.collection("complianceDocuments").get(),
    ]);
    if (!driverSnap.exists) return res.status(404).json({ error: "Driver not found" });

    // Generate signed URLs for each document so the admin can view
    // them without separate Storage auth in the browser.
    const documents = await Promise.all(
      docsSnap.docs.map(async (d) => {
        const data = d.data();
        let viewerUrl = data.storageURL;
        if (data.storageURL && data.storageURL.includes("firebasestorage.app")) {
          try {
            // Pull the storage path out of the URL and re-sign with 1 h validity
            const path = decodeURIComponent(
              data.storageURL.split("/o/")[1].split("?")[0]
            );
            const [signed] = await bucket
              .file(path)
              .getSignedUrl({ action: "read", expires: Date.now() + 60 * 60 * 1000 });
            viewerUrl = signed;
          } catch (e) {
            console.warn(`Couldn't sign URL for ${d.id}:`, e.message);
          }
        }
        return {
          docType: d.id,
          ...data,
          viewerUrl,
        };
      })
    );

    res.json({
      driver: { id: driverSnap.id, ...driverSnap.data() },
      documents,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/drivers/:id/verify", async (req, res) => {
  try {
    await db.collection("drivers").doc(req.params.id).update({
      isVerified: true,
      verifiedAt: FieldValue.serverTimestamp(),
      verifiedBy: "admin",
      updatedAt: FieldValue.serverTimestamp(),
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/drivers/:id/suspend", async (req, res) => {
  const { suspended = true, reason = "" } = req.body || {};
  try {
    await db.collection("drivers").doc(req.params.id).update({
      isActive: !suspended,
      suspendedReason: suspended ? reason : FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  Document review
// ────────────────────────────────────────────────────────────────────────────

app.post("/api/drivers/:id/docs/:type/approve", async (req, res) => {
  try {
    const ref = db.collection("drivers").doc(req.params.id)
      .collection("complianceDocuments").doc(req.params.type);
    await ref.update({
      verificationStatus: "approved",
      reviewedAt: FieldValue.serverTimestamp(),
      rejectionReason: FieldValue.delete(),
    });

    // Optional: flip the legacy verified flags on the driver doc
    const verifyFlag = {
      dl_front: "licenseVerified",
      coi: "insuranceVerified",
      registration: "insuranceVerified", // historical
    }[req.params.type];
    if (verifyFlag) {
      await db.collection("drivers").doc(req.params.id).update({
        [verifyFlag]: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/drivers/:id/docs/:type/reject", async (req, res) => {
  const { reason = "" } = req.body || {};
  try {
    await db.collection("drivers").doc(req.params.id)
      .collection("complianceDocuments").doc(req.params.type)
      .update({
        verificationStatus: "rejected",
        rejectionReason: reason,
        reviewedAt: FieldValue.serverTimestamp(),
      });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
//  Weekly payouts
// ────────────────────────────────────────────────────────────────────────────

// ISO week, Monday-anchored (matches the iOS app's bucket logic).
function isoWeekBoundaries(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = (jan4.getUTCDay() || 7);
  const monWeek1 = new Date(jan4);
  monWeek1.setUTCDate(jan4.getUTCDate() - day + 1);
  const start = new Date(monWeek1);
  start.setUTCDate(monWeek1.getUTCDate() + (week - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { start, end };
}

app.get("/api/drivers/:id/payouts/:week", async (req, res) => {
  const m = req.params.week.match(/^(\d{4})_W(\d{2})$/);
  if (!m) return res.status(400).json({ error: "Week format: 2026_W26" });
  const year = parseInt(m[1], 10);
  const week = parseInt(m[2], 10);
  const { start, end } = isoWeekBoundaries(year, week);

  try {
    const driverId = req.params.id;

    // Completed rides in this window
    const ridesSnap = await db.collection("rides")
      .where("driverId", "==", driverId)
      .where("status", "==", "completed")
      .where("completedAt", ">=", Timestamp.fromDate(start))
      .where("completedAt", "<",  Timestamp.fromDate(end))
      .get();

    let fareNet = 0, tips = 0, trips = 0;
    const tripDetails = [];
    for (const doc of ridesSnap.docs) {
      const r = doc.data();
      const fee = r.leadSource === "driver_sourced" ? 0.10 : 0.18;
      const net = (r.fare || 0) * (1 - fee);
      const tip = r.tip || 0;
      fareNet += net;
      tips += tip;
      trips += 1;
      tripDetails.push({
        id: doc.id,
        completedAt: r.completedAt?.toDate?.()?.toISOString(),
        fare: r.fare,
        tip,
        fareNet: net,
        riderName: r.riderName,
        pickupAddress: r.pickupAddress,
        dropoffAddress: r.dropoffAddress,
      });
    }

    // Cancellation fees credited to this driver in this window
    const cancelsSnap = await db.collection("rides")
      .where("cancellationFeeDriverId", "==", driverId)
      .where("cancelledAt", ">=", Timestamp.fromDate(start))
      .where("cancelledAt", "<",  Timestamp.fromDate(end))
      .get();
    let cancelFees = 0;
    const cancelDetails = [];
    for (const doc of cancelsSnap.docs) {
      const c = doc.data();
      const fee = c.cancellationFeeCreditedToDriver || 0;
      cancelFees += fee;
      cancelDetails.push({
        id: doc.id,
        cancelledAt: c.cancelledAt?.toDate?.()?.toISOString(),
        fee,
        tier: c.cancellationTier,
      });
    }

    // Has the admin already marked this week paid?
    const paidSnap = await db.collection("drivers").doc(driverId)
      .collection("payouts").doc(req.params.week).get();
    const paid = paidSnap.exists ? paidSnap.data() : null;

    res.json({
      driverId,
      week: req.params.week,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      trips,
      fareNet,
      tips,
      cancelFees,
      total: fareNet + tips + cancelFees,
      paid,
      tripDetails,
      cancelDetails,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/drivers/:id/payouts/:week/mark-paid", async (req, res) => {
  const { amount, method = "venmo", note = "" } = req.body || {};
  try {
    await db.collection("drivers").doc(req.params.id)
      .collection("payouts").doc(req.params.week)
      .set({
        paidAt: FieldValue.serverTimestamp(),
        amount: amount ?? null,
        method,
        note,
        markedBy: "admin",
      }, { merge: true });

    // Also reset the driver's pendingPayout if you want — careful,
    // this assumes the admin paid the FULL pending balance.
    // Commenting out by default to avoid accidental zero-out.
    //
    // await db.collection("drivers").doc(req.params.id).update({
    //   pendingPayout: 0,
    //   updatedAt: FieldValue.serverTimestamp(),
    // });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/drivers/:id/payouts/:week/mark-unpaid", async (req, res) => {
  try {
    await db.collection("drivers").doc(req.params.id)
      .collection("payouts").doc(req.params.week).delete();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pending payouts across all drivers for the CURRENT week
app.get("/api/payouts/pending", async (_req, res) => {
  try {
    const now = new Date();
    const year = now.getUTCFullYear();
    // Quick ISO-week-of-year for current date
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const day = (jan4.getUTCDay() || 7);
    const monWeek1 = new Date(jan4);
    monWeek1.setUTCDate(jan4.getUTCDate() - day + 1);
    const week = Math.floor((now - monWeek1) / (7 * 86400000)) + 1;
    const weekKey = `${year}_W${String(week).padStart(2, "0")}`;

    const driversSnap = await db.collection("drivers").get();
    const out = [];
    for (const d of driversSnap.docs) {
      // Reuse the same logic as the per-driver endpoint
      const r = await fetch(`http://localhost:${process.env.PORT || 3000}/api/drivers/${d.id}/payouts/${weekKey}`, {
        headers: { Authorization: `Bearer ${process.env.ADMIN_API_TOKEN || ""}` },
      });
      if (r.ok) out.push(await r.json());
    }
    res.json({ week: weekKey, drivers: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🛡  RVIP admin backend listening on :${PORT}`);
});
