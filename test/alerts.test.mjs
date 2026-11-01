/**
 * M2.1 / PM-175 — Alerts engine acceptance.
 * Fixture: 5 users / 12 rules / 2 snapshots → exactly 7 events; re-run → 0.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openMemoryDb } from "./memory_db.mjs";

const { webcrypto } = await import("node:crypto");
if (!globalThis.crypto) globalThis.crypto = webcrypto;

process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} --experimental-strip-types`;

const {
  createRule,
  FREE_RULE_CAP,
  listRules,
} = await import("../src/alerts/rules.ts");
const {
  evaluateAlerts,
  estimateDailyWrites,
  headlineAllowed,
} = await import("../src/alerts/evaluate.ts");
const { deliverPending } = await import("../src/alerts/deliver.ts");
const {
  confirmDoubleOptIn,
  ensureEmailPrefs,
  unsubscribeByToken,
  rawUnsubscribeTokenForUser,
  canSendAlertEmail,
  getEmailPrefs,
} = await import("../src/alerts/prefs.ts");
const { renderAlertEmail, renderOptInEmail } = await import(
  "../src/alerts/templates.ts"
);
const { findBannedPhrase } = await import("../src/alerts/banned.ts");
const { isValidDiscordWebhookUrl, encryptWebhookUrl, decryptWebhookUrl } =
  await import("../src/alerts/webhook_crypto.ts");
const { hardDeleteUser } = await import("../src/auth/magic.ts");
const { countUserOwned } = await import("../src/ports/db.ts");
const { captureEmail } = await import("../src/email.ts");

const ENC = "test-webhook-enc-secret-m21";
const DAY1 = "2026-10-30";
const DAY2 = "2026-10-31";

async function seedUser(db, id, email) {
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified_at, created_at, tier)
       VALUES (?, ?, ?, ?, 'free')`,
    )
    .bind(id, email, `${DAY2}T00:00:00Z`, `${DAY1}T00:00:00Z`)
    .run();
}

async function seedHistory(db, row) {
  await db
    .prepare(
      `INSERT INTO ladder_history_90d (
         print_id, grade_label, snapshot_date, p50, n, passport_grade, newest_sold_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.print_id,
      row.grade_label,
      row.snapshot_date,
      row.p50,
      row.n,
      row.passport_grade,
      row.newest_sold_at,
    )
    .run();
}

async function seedLatest(db, row) {
  await db
    .prepare(
      `INSERT INTO ladder_latest (
         print_id, grade_label, p25, p50, p75, n,
         passport_grade, newest_sold_at, snapshot_date
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.print_id,
      row.grade_label,
      row.p50,
      row.p50,
      row.p50,
      row.n,
      row.passport_grade,
      row.newest_sold_at,
      row.snapshot_date,
    )
    .run();
}

async function buildFixture() {
  const db = openMemoryDb();
  const users = [
    ["u1", "u1@example.com"],
    ["u2", "u2@example.com"],
    ["u3", "u3@example.com"],
    ["u4", "u4@example.com"],
    ["u5", "u5@example.com"],
  ];
  for (const [id, email] of users) await seedUser(db, id, email);

  // Day-1 history (prior night)
  const hist = [
    { print_id: "p1", grade_label: "Ungraded", p50: 1000, n: 3, passport_grade: "C", newest_sold_at: "2026-10-20T00:00:00Z" },
    { print_id: "p2", grade_label: "PSA 10", p50: 5000, n: 5, passport_grade: "B", newest_sold_at: "2026-10-21T00:00:00Z" },
    { print_id: "p3", grade_label: "PSA 9", p50: 2000, n: 3, passport_grade: "A", newest_sold_at: "2026-10-22T00:00:00Z" },
    { print_id: "p4", grade_label: "NM", p50: 800, n: 3, passport_grade: "D", newest_sold_at: "2026-10-23T00:00:00Z" },
    { print_id: "p5", grade_label: "PSA 8", p50: 3000, n: 3, passport_grade: "C", newest_sold_at: "2026-10-24T00:00:00Z" },
    { print_id: "p6", grade_label: "Ungraded", p50: 10000, n: 10, passport_grade: "A", newest_sold_at: "2026-10-25T00:00:00Z" },
  ];
  for (const r of hist) await seedHistory(db, { ...r, snapshot_date: DAY1 });

  // Day-2 latest
  const latest = [
    { print_id: "p1", grade_label: "Ungraded", p50: 1500, n: 4, passport_grade: "C", newest_sold_at: "2026-10-30T00:00:00Z" },
    { print_id: "p2", grade_label: "PSA 10", p50: 4000, n: 5, passport_grade: "B", newest_sold_at: "2026-10-21T00:00:00Z" },
    { print_id: "p3", grade_label: "PSA 9", p50: 2200, n: 3, passport_grade: "A", newest_sold_at: "2026-10-22T00:00:00Z" },
    { print_id: "p4", grade_label: "NM", p50: 900, n: 4, passport_grade: "D", newest_sold_at: "2026-10-29T00:00:00Z" },
    { print_id: "p5", grade_label: "PSA 8", p50: 3000, n: 3, passport_grade: "B", newest_sold_at: "2026-10-24T00:00:00Z" },
    { print_id: "p6", grade_label: "Ungraded", p50: 12000, n: 11, passport_grade: "A", newest_sold_at: "2026-10-25T00:00:00Z" },
  ];
  for (const r of latest) await seedLatest(db, { ...r, snapshot_date: DAY2 });

  // 12 rules — exactly 7 should fire (pre-computed)
  const specs = [
    { user: "u1", print_id: "p1", grade_label: "Ungraded", kind: "median_above", threshold: 1200, channel: "email" }, // FIRE
    { user: "u1", print_id: "p1", grade_label: "Ungraded", kind: "new_comp", threshold: null, channel: "email" }, // FIRE
    { user: "u2", print_id: "p2", grade_label: "PSA 10", kind: "median_below", threshold: 4500, channel: "email" }, // FIRE
    { user: "u2", print_id: "p3", grade_label: "PSA 9", kind: "pct_move_7d", threshold: 500, channel: "rss" }, // FIRE ~1000bps
    { user: "u3", print_id: "p4", grade_label: "NM", kind: "median_above", threshold: 100, channel: "email" }, // no (D)
    { user: "u3", print_id: "p4", grade_label: "NM", kind: "new_comp", threshold: null, channel: "email" }, // no (D)
    { user: "u3", print_id: "p5", grade_label: "PSA 8", kind: "passport_change", threshold: null, channel: "email" }, // FIRE
    { user: "u4", print_id: "p6", grade_label: "Ungraded", kind: "pct_move_7d", threshold: 1500, channel: "email" }, // FIRE
    { user: "u4", print_id: "p2", grade_label: "PSA 10", kind: "median_above", threshold: 6000, channel: "email" }, // no
    { user: "u5", print_id: "p1", grade_label: "Ungraded", kind: "median_below", threshold: 500, channel: "email" }, // no
    { user: "u5", print_id: "p3", grade_label: "PSA 9", kind: "median_above", threshold: 5000, channel: "email" }, // no
    { user: "u5", print_id: "p6", grade_label: "Ungraded", kind: "new_comp", threshold: null, channel: "discord_webhook", webhook: "https://discord.com/api/webhooks/1234567890123456789/abcdefghijklmnopqrstuvwx-YZ_0123456789abcdefghi" }, // FIRE
  ];
  assert.equal(specs.length, 12);

  for (const s of specs) {
    const r = await createRule({
      db,
      userId: s.user,
      printId: s.print_id,
      gradeLabel: s.grade_label,
      kind: s.kind,
      threshold: s.threshold,
      channel: s.channel,
      webhookUrl: s.webhook || null,
      encSecret: ENC,
    });
    assert.equal(r.ok, true, r.error);
  }
  return db;
}

describe("M2.1 schema", () => {
  it("0002_alerts.sql creates alert tables", async () => {
    const db = openMemoryDb();
    const tables = db._raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1")
      .all()
      .map((r) => r.name);
    for (const t of [
      "alert_rule",
      "alert_event",
      "delivery",
      "email_prefs",
      "rss_tokens",
      "alert_delivery_budget",
    ]) {
      assert.ok(tables.includes(t), t);
    }
    const cols = db._raw
      .prepare("PRAGMA table_info(ladder_history_90d)")
      .all()
      .map((c) => c.name);
    assert.ok(cols.includes("passport_grade"));
    assert.ok(cols.includes("newest_sold_at"));
  });
});

describe("fixture evaluate", () => {
  it("5 users / 12 rules / 2 snapshots → exactly 7 events; re-run → 0", async () => {
    const db = await buildFixture();
    const first = await evaluateAlerts(db, { now: new Date(`${DAY2}T10:00:00Z`) });
    assert.equal(first.events_created, 7, JSON.stringify(first));
    assert.equal(first.cells_skipped_passport >= 2, true);

    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM alert_event")
      .first();
    assert.equal(Number(count.n), 7);

    const second = await evaluateAlerts(db, { now: new Date(`${DAY2}T10:05:00Z`) });
    assert.equal(second.events_created, 0);
    assert.equal(second.events_idempotent_skip, 7);

    const count2 = await db
      .prepare("SELECT COUNT(*) AS n FROM alert_event")
      .first();
    assert.equal(Number(count2.n), 7);
  });

  it("write budget sim 1000×10 ≤ 10k", () => {
    const n = estimateDailyWrites(1000, 10);
    console.log(JSON.stringify({ write_budget_sim_1000x10: n, ok: n <= 10_000 }));
    assert.equal(n, 10_000);
    assert.ok(n <= 10_000);
  });
});

describe("rules + caps", () => {
  it("rejects 21st free rule with clear message", async () => {
    const db = openMemoryDb();
    await seedUser(db, "u", "cap@example.com");
    await seedLatest(db, {
      print_id: "px",
      grade_label: "Ungraded",
      p50: 100,
      n: 3,
      passport_grade: "C",
      newest_sold_at: null,
      snapshot_date: DAY2,
    });
    for (let i = 0; i < FREE_RULE_CAP; i++) {
      const r = await createRule({
        db,
        userId: "u",
        printId: `p${i}`,
        gradeLabel: "Ungraded",
        kind: "new_comp",
        channel: "email",
        encSecret: ENC,
      });
      assert.equal(r.ok, true, r.error);
    }
    const over = await createRule({
      db,
      userId: "u",
      printId: "overflow",
      gradeLabel: "Ungraded",
      kind: "new_comp",
      channel: "email",
      encSecret: ENC,
    });
    assert.equal(over.ok, false);
    assert.equal(over.status, 403);
    assert.match(over.error, /rule_cap_exceeded/);
    assert.match(over.error, /20/);
  });

  it("validates discord webhook URLs", () => {
    assert.equal(
      isValidDiscordWebhookUrl(
        "https://discord.com/api/webhooks/1234567890123456789/abcDEF_-0123456789",
      ),
      true,
    );
    assert.equal(
      isValidDiscordWebhookUrl("https://evil.example/api/webhooks/1/x"),
      false,
    );
  });

  it("encrypts webhook URLs round-trip", async () => {
    const url =
      "https://discord.com/api/webhooks/1234567890123456789/abcdefghijklmnopqrstuvwx";
    const ct = await encryptWebhookUrl(ENC, url);
    assert.ok(ct.startsWith("v1."));
    assert.equal(await decryptWebhookUrl(ENC, ct), url);
  });
});

describe("email prefs + unsubscribe", () => {
  it("unsubscribe works without login; suppressed users get no mail", async () => {
    const db = openMemoryDb();
    await seedUser(db, "u1", "a@example.com");
    await ensureEmailPrefs(db, "u1");
    await confirmDoubleOptIn(db, "u1");
    assert.equal(canSendAlertEmail(await getEmailPrefs(db, "u1")), true);

    const raw = await rawUnsubscribeTokenForUser(db, "u1");
    const un = await unsubscribeByToken(db, raw);
    assert.equal(un.ok, true);
    assert.equal(canSendAlertEmail(await getEmailPrefs(db, "u1")), false);

    // Seed a firing email rule + event path via evaluate
    await seedHistory(db, {
      print_id: "p1",
      grade_label: "Ungraded",
      snapshot_date: DAY1,
      p50: 1000,
      n: 3,
      passport_grade: "C",
      newest_sold_at: "t1",
    });
    await seedLatest(db, {
      print_id: "p1",
      grade_label: "Ungraded",
      p50: 2000,
      n: 4,
      passport_grade: "C",
      newest_sold_at: "t2",
      snapshot_date: DAY2,
    });
    const created = await createRule({
      db,
      userId: "u1",
      printId: "p1",
      gradeLabel: "Ungraded",
      kind: "median_above",
      threshold: 1500,
      channel: "email",
      encSecret: ENC,
    });
    assert.equal(created.ok, true);
    await evaluateAlerts(db);

    const box = { messages: [] };
    const stats = await deliverPending(db, {
      emailPort: captureEmail(box),
      encSecret: ENC,
      siteOrigin: "https://pokemart.online",
      now: new Date(`${DAY2}T10:00:00Z`),
    });
    assert.equal(box.messages.length, 0);
    assert.ok(stats.skipped >= 1);
  });

  it("double opt-in required before send", async () => {
    const db = openMemoryDb();
    await seedUser(db, "u1", "b@example.com");
    await ensureEmailPrefs(db, "u1"); // no confirm
    await seedHistory(db, {
      print_id: "p1",
      grade_label: "Ungraded",
      snapshot_date: DAY1,
      p50: 1000,
      n: 3,
      passport_grade: "C",
      newest_sold_at: null,
    });
    await seedLatest(db, {
      print_id: "p1",
      grade_label: "Ungraded",
      p50: 2000,
      n: 3,
      passport_grade: "C",
      newest_sold_at: null,
      snapshot_date: DAY2,
    });
    await createRule({
      db,
      userId: "u1",
      printId: "p1",
      gradeLabel: "Ungraded",
      kind: "median_above",
      threshold: 1500,
      channel: "email",
      encSecret: ENC,
    });
    await evaluateAlerts(db);
    const box = { messages: [] };
    await deliverPending(db, {
      emailPort: captureEmail(box),
      encSecret: ENC,
      siteOrigin: "https://pokemart.online",
    });
    assert.equal(box.messages.length, 0);

    await confirmDoubleOptIn(db, "u1");
    // Reset delivery to pending
    await db.prepare("DELETE FROM delivery").run();
    const box2 = { messages: [] };
    await deliverPending(db, {
      emailPort: captureEmail(box2),
      encSecret: ENC,
      siteOrigin: "https://pokemart.online",
    });
    assert.equal(box2.messages.length, 1);
    const msg = box2.messages[0];
    assert.ok(msg.text.includes("n="));
    assert.ok(/Passport/i.test(msg.text));
    assert.ok(/Browse-API|proxy|capture/i.test(msg.text));
    assert.ok(/Evidence|evidence|search/i.test(msg.text));
    assert.equal(findBannedPhrase(msg.subject + msg.text + msg.html), null);
  });
});

describe("copy guards", () => {
  it("alert email templates contain no banned phrases and show n + passport + capture + link", () => {
    const body = renderAlertEmail({
      siteOrigin: "https://pokemart.online",
      unsubscribeUrl: "https://pokemart.online/account/unsubscribe?token=x",
      items: [
        {
          kind: "median_above",
          print_id: "p1",
          grade_label: "Ungraded",
          snapshot_date: DAY2,
          n: 4,
          passport_grade: "C",
          p50: 1500,
          capture_note:
            "Medians are Browse-API ended-auction last-bid proxies, not confirmed sold prices.",
          evidence_path: "/search/?q=p1",
        },
      ],
    });
    assert.equal(findBannedPhrase(body.subject + body.text + body.html), null);
    assert.match(body.text, /n=4/);
    assert.match(body.text, /Passport C/);
    assert.match(body.text, /prox(?:y|ies)/);
    assert.match(body.text, /pokemart\.online\/search/);
    const opt = renderOptInEmail({
      confirmUrl: "https://pokemart.online/account/alerts/confirm",
    });
    assert.equal(findBannedPhrase(opt.subject + opt.text), null);
  });

  it("headlineAllowed matches passport A–C only", () => {
    assert.equal(headlineAllowed("A"), true);
    assert.equal(headlineAllowed("B"), true);
    assert.equal(headlineAllowed("C"), true);
    assert.equal(headlineAllowed("D"), false);
  });
});

describe("hard delete clears alert rows", () => {
  it("delete user → alert_rule / email_prefs / rss_tokens counts 0", async () => {
    const db = await buildFixture();
    await ensureEmailPrefs(db, "u1");
    await hardDeleteUser(db, "u1");
    const left = await countUserOwned(db, "u1");
    assert.equal(left.users, 0);
    assert.equal(left.alert_rule, 0);
    assert.equal(left.email_prefs, 0);
    assert.equal(left.rss_tokens, 0);
    const rules = await listRules(db, "u1");
    assert.equal(rules.length, 0);
  });
});
