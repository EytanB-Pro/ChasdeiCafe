// Vercel serverless function: /api/orders
// Storage: Upstash Redis (add it from the Vercel Marketplace -> Storage).
const crypto = require("crypto");

const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const PRICE = 7.0;
const REMOVABLE = ["Eggs", "Potatoes"];
const ADDONS = ["Spicy (Sriracha)", "Extra Cheese", "Chasdei Sauce"];

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

function isAdmin(req) {
  const given = String(req.headers["x-admin-password"] || "");
  if (!ADMIN_PASSWORD || !given) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

const clean = (s, n) => String(s || "").replace(/[<>]/g, "").trim().slice(0, n);

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!URL_ || !TOKEN) return res.status(500).json({ error: "Database not configured" });

  try {
    // ---- Customer: place an order ----
    if (req.method === "POST") {
      const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const name = clean(b.name, 60), phone = clean(b.phone, 25);
      if (!name || !phone) return res.status(400).json({ error: "Name and phone required" });
      const qty = Math.min(20, Math.max(1, parseInt(b.qty, 10) || 1));
      const order = {
        id: Date.now().toString(36) + crypto.randomBytes(3).toString("hex"),
        name,
        phone,
        notes: clean(b.notes, 200),
        removed: (Array.isArray(b.removed) ? b.removed : []).filter((x) => REMOVABLE.includes(x)),
        addons: (Array.isArray(b.addons) ? b.addons : []).filter((x) => ADDONS.includes(x)),
        qty,
        total: PRICE * qty, // computed server-side
        status: "new",
        createdAt: Date.now(),
      };
      await redis(["HSET", "orders", order.id, JSON.stringify(order)]);
      return res.status(201).json({ ok: true });
    }

    // ---- Everything below is admin only ----
    if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized" });

    if (req.method === "GET") {
      const flat = (await redis(["HGETALL", "orders"])) || [];
      const orders = [];
      for (let i = 1; i < flat.length; i += 2) {
        try { orders.push(JSON.parse(flat[i])); } catch (e) {}
      }
      return res.status(200).json({ orders });
    }

    const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const id = clean(b.id, 40);
    if (!id) return res.status(400).json({ error: "id required" });

    if (req.method === "PATCH") {
      if (!["new", "ready", "done"].includes(b.status)) return res.status(400).json({ error: "bad status" });
      const raw = await redis(["HGET", "orders", id]);
      if (!raw) return res.status(404).json({ error: "not found" });
      const o = JSON.parse(raw);
      o.status = b.status;
      await redis(["HSET", "orders", id, JSON.stringify(o)]);
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      await redis(["HDEL", "orders", id]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
};
