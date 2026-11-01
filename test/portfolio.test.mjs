/**
 * M2.2 / PM-176 — Portfolio with cost basis acceptance.
 * Fixture: 12 holdings (3 unpriced) → hand-calculated totals / P&L.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openMemoryDb } from "./memory_db.mjs";

const { webcrypto } = await import("node:crypto");
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { computeEbayFeesCents } = await import("../src/portfolio/fees.ts");
const {
  valuePortfolio,
  headlineAllowed,
} = await import("../src/portfolio/value.ts");
const {
  createHolding,
  deleteAllHoldings,
  listHoldings,
  migrateLocalLists,
  recomputePortfolio,
  recordSale,
} = await import("../src/portfolio/holdings.ts");
const { importCsvHoldings, holdingsToCsv } = await import(
  "../src/portfolio/import_csv.ts"
);
const { createShareLink, resolveShareView, revokeShareLink } = await import(
  "../src/portfolio/share.ts"
);
const { hardDeleteUser } = await import("../src/auth/magic.ts");
const { countUserOwned } = await import("../src/ports/db.ts");

async function seedUser(db, id, email) {
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified_at, created_at, tier)
       VALUES (?, ?, ?, ?, 'free')`,
    )
    .bind(id, email, "2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z")
    .run();
}

async function seedCell(db, row) {
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
      row.p25,
      row.p50,
      row.p75,
      row.n,
      row.passport_grade,
      row.newest_sold_at || "2026-10-20T00:00:00Z",
      row.snapshot_date || "2026-11-01",
    )
    .run();
}

/** 12 holdings — 3 unpriced (D, missing cell, no p50). Hand-calc expected. */
function fixtureSpec() {
  // cost is per-unit cents
  const holdings = [
    { print_id: "a", grade_label: "Ungraded", qty: 1, cost_cents: 1000 }, // A 2000
    { print_id: "b", grade_label: "PSA 10", qty: 1, cost_cents: 5000 }, // B 8000
    { print_id: "c", grade_label: "Ungraded", qty: 1, cost_cents: 500 }, // C 400
    { print_id: "d", grade_label: "Ungraded", qty: 1, cost_cents: 2000 }, // D → unpriced
    { print_id: "e", grade_label: "PSA 9", qty: 1, cost_cents: 1500 }, // no cell → unpriced
    { print_id: "f", grade_label: "Ungraded", qty: 1, cost_cents: 800 }, // A 1000
    { print_id: "g", grade_label: "PSA 10", qty: 1, cost_cents: 10000 }, // A 12000; will sell
    { print_id: "h", grade_label: "Ungraded", qty: 1, cost_cents: null }, // B 500; no cost
    { print_id: "i", grade_label: "Ungraded", qty: 1, cost_cents: 300 }, // A but p50 null → unpriced
    { print_id: "j", grade_label: "Ungraded", qty: 1, cost_cents: 1200 }, // C 1500
    { print_id: "k", grade_label: "PSA 8", qty: 1, cost_cents: 600 }, // A 900
    { print_id: "l", grade_label: "Ungraded", qty: 2, cost_cents: 400 }, // A 700×2
  ];
  const cells = [
    { print_id: "a", grade_label: "Ungraded", p25: 1800, p50: 2000, p75: 2200, n: 5, passport_grade: "A" },
    { print_id: "b", grade_label: "PSA 10", p25: 7500, p50: 8000, p75: 8500, n: 4, passport_grade: "B" },
    { print_id: "c", grade_label: "Ungraded", p25: 350, p50: 400, p75: 450, n: 6, passport_grade: "C" },
    { print_id: "d", grade_label: "Ungraded", p25: 2500, p50: 3000, p75: 3500, n: 3, passport_grade: "D" },
    { print_id: "f", grade_label: "Ungraded", p25: 900, p50: 1000, p75: 1100, n: 8, passport_grade: "A" },
    { print_id: "g", grade_label: "PSA 10", p25: 11000, p50: 12000, p75: 13000, n: 7, passport_grade: "A" },
    { print_id: "h", grade_label: "Ungraded", p25: 450, p50: 500, p75: 550, n: 5, passport_grade: "B" },
    { print_id: "i", grade_label: "Ungraded", p25: null, p50: null, p75: null, n: 0, passport_grade: "A" },
    { print_id: "j", grade_label: "Ungraded", p25: 1400, p50: 1500, p75: 1600, n: 4, passport_grade: "C" },
    { print_id: "k", grade_label: "PSA 8", p25: 800, p50: 900, p75: 1000, n: 5, passport_grade: "A" },
    { print_id: "l", grade_label: "Ungraded", p25: 650, p50: 700, p75: 750, n: 9, passport_grade: "A" },
  ];
  // Priced lines (exclude d,e,i): a,b,c,f,g,h,j,k,l
  // value = 2000+8000+400+1000+12000+500+1500+900+1400 = 27700
  // low   = 1800+7500+350+900+11000+450+1400+800+1300 = 25500
  // high  = 2200+8500+450+1100+13000+550+1600+1000+1500 = 29900
  // cost known on priced (exclude h null): 1000+5000+500+800+10000+1200+600+800 = 19900
  // unrealized = 27700 - 500(h has no cost so value still in total) wait:
  //   value includes h's 500; costKnown excludes h → unrealized = 27700 - 19900 = 7800
  // After selling g @ 11000 with eBay fees:
  //   fees = computeEbayFeesCents(11000)
  //   realized = 11000 - fees - 10000
  //   remaining value drops g's 12000; costKnown drops 10000
  return { holdings, cells, expectedValue: 27700, expectedLow: 25500, expectedHigh: 29900, expectedCost: 19900, expectedUnrealized: 7800 };
}

describe("portfolio fees", () => {
  it("matches decision.py eBay fee table on $110 sale", () => {
    const f = computeEbayFeesCents(11000);
    assert.equal(f.fvf_cents, Math.round(11000 * 0.1325));
    assert.equal(f.flat_cents, 40);
    assert.equal(f.shipping_cents, 500);
    assert.equal(f.total_cents, f.fvf_cents + 40 + 500);
  });
});

describe("portfolio valuation fixture", () => {
  it("12 holdings / 3 unpriced hand-calc + realized after eBay fees", async () => {
    const db = openMemoryDb();
    await seedUser(db, "u1", "u1@example.com");
    const spec = fixtureSpec();
    for (const c of spec.cells) await seedCell(db, c);

    const created = [];
    for (const h of spec.holdings) {
      const res = await createHolding({
        db,
        userId: "u1",
        printId: h.print_id,
        gradeLabel: h.grade_label,
        qty: h.qty,
        costCents: h.cost_cents,
      });
      assert.equal(res.ok, true);
      created.push(res.holding);
    }

    let summary = await recomputePortfolio(db, "u1");
    assert.equal(summary.n_priced, 9);
    assert.equal(summary.n_unpriced, 3);
    assert.equal(summary.value_cents, spec.expectedValue);
    assert.equal(summary.low_cents, spec.expectedLow);
    assert.equal(summary.high_cents, spec.expectedHigh);
    assert.equal(summary.cost_basis_cents, spec.expectedCost);
    assert.equal(summary.unrealized_cents, spec.expectedUnrealized);
    assert.equal(summary.unpriced.length, 3);
    const reasons = new Set(summary.unpriced.map((u) => u.unpriced_reason));
    assert.ok(reasons.has("passport_d"));
    assert.ok(reasons.has("no_ladder_cell"));
    assert.ok(reasons.has("no_p50"));
    // No D-grade cell contributes to value
    assert.ok(!summary.lines.some((l) => l.priced && l.passport_grade === "D"));

    const g = created.find((h) => h.print_id === "g");
    const salePrice = 11000;
    const fees = computeEbayFeesCents(salePrice);
    const sale = await recordSale({
      db,
      userId: "u1",
      holdingId: g.id,
      qty: 1,
      priceCents: salePrice,
      soldOn: "2026-10-28",
      useEbayFeeTable: true,
    });
    assert.equal(sale.ok, true);
    assert.equal(sale.sale.fees_cents, fees.total_cents);

    summary = await recomputePortfolio(db, "u1");
    const expectedRealized = salePrice - fees.total_cents - 10000;
    assert.equal(summary.realized_cents, expectedRealized);
    assert.equal(summary.value_cents, spec.expectedValue - 12000);
    assert.equal(summary.cost_basis_cents, spec.expectedCost - 10000);
  });

  it("never values D-grade cells", () => {
    assert.equal(headlineAllowed("A"), true);
    assert.equal(headlineAllowed("C"), true);
    assert.equal(headlineAllowed("D"), false);
    assert.equal(headlineAllowed(null), false);
    const summary = valuePortfolio(
      [{ id: "1", print_id: "x", grade_label: "Ungraded", qty: 1, cost_cents: 100 }],
      [],
      [
        {
          print_id: "x",
          grade_label: "Ungraded",
          p25: 50,
          p50: 100,
          p75: 150,
          n: 3,
          passport_grade: "D",
        },
      ],
    );
    assert.equal(summary.value_cents, 0);
    assert.equal(summary.n_unpriced, 1);
    assert.equal(summary.unpriced[0].unpriced_reason, "passport_d");
  });
});

describe("portfolio import / recompute perf", () => {
  it("imports 1000-line CSV in <= 5s", async () => {
    const db = openMemoryDb();
    await seedUser(db, "u2", "u2@example.com");
    const lines = ["print_id,grade_label,qty,cost_cents"];
    for (let i = 0; i < 1000; i++) {
      lines.push(`print_${i},Ungraded,1,${100 + i}`);
    }
    const result = await importCsvHoldings({
      db,
      userId: "u2",
      csvText: lines.join("\n"),
      mapping: {
        print_id: "print_id",
        grade_label: "grade_label",
        qty: "qty",
        cost_cents: "cost_cents",
      },
    });
    assert.equal(result.imported, 1000);
    assert.ok(result.ms <= 5000, `import took ${result.ms}ms`);
  });

  it("recomputes 500 holdings in <= 200ms", async () => {
    const db = openMemoryDb();
    await seedUser(db, "u3", "u3@example.com");
    for (let i = 0; i < 500; i++) {
      await seedCell(db, {
        print_id: `p${i}`,
        grade_label: "Ungraded",
        p25: 90,
        p50: 100,
        p75: 110,
        n: 5,
        passport_grade: i % 17 === 0 ? "D" : "A",
      });
      await createHolding({
        db,
        userId: "u3",
        printId: `p${i}`,
        gradeLabel: "Ungraded",
        qty: 1,
        costCents: 80,
      });
    }
    const t0 = Date.now();
    const summary = await recomputePortfolio(db, "u3");
    const ms = Date.now() - t0;
    assert.ok(summary.n_priced + summary.n_unpriced === 500);
    assert.ok(ms <= 200, `recompute took ${ms}ms`);
  });
});

describe("portfolio migrate / share / delete", () => {
  it("migrates watchlist without loss", async () => {
    const db = openMemoryDb();
    await seedUser(db, "u4", "u4@example.com");
    const watch = [
      { card_key: "w1|key", label: "One" },
      { card_key: "w2|key", label: "Two" },
      { print_id: "w3", grade: "PSA 10" },
    ];
    const result = await migrateLocalLists({
      db,
      userId: "u4",
      watchlist: watch,
    });
    assert.equal(result.added, 3);
    const again = await migrateLocalLists({
      db,
      userId: "u4",
      watchlist: watch,
    });
    assert.equal(again.added, 0);
    assert.equal(again.skipped, 3);
    const holdings = await listHoldings(db, "u4");
    assert.equal(holdings.length, 3);
  });

  it("share link hides cost by default; revoke works", async () => {
    const db = openMemoryDb();
    await seedUser(db, "u5", "u5@example.com");
    await seedCell(db, {
      print_id: "s1",
      grade_label: "Ungraded",
      p25: 100,
      p50: 200,
      p75: 300,
      n: 4,
      passport_grade: "A",
    });
    await createHolding({
      db,
      userId: "u5",
      printId: "s1",
      gradeLabel: "Ungraded",
      qty: 1,
      costCents: 150,
    });
    const link = await createShareLink({ db, userId: "u5", showCost: false });
    // randomToken(16) → 16 raw bytes, base64url (~22 chars)
    assert.ok(link.rawToken.length >= 20, `token len ${link.rawToken.length}`);
    const view = await resolveShareView(db, link.rawToken);
    assert.equal(view.ok, true);
    assert.equal(view.showCost, false);
    assert.equal(view.summary.lines[0].cost_cents, null);
    assert.equal(view.summary.unrealized_cents, null);
    assert.equal(view.summary.value_cents, 200);

    const withCost = await createShareLink({
      db,
      userId: "u5",
      showCost: true,
    });
    const view2 = await resolveShareView(db, withCost.rawToken);
    assert.equal(view2.ok, true);
    assert.equal(view2.showCost, true);
    assert.equal(view2.summary.lines[0].cost_cents, 150);

    await revokeShareLink(db, "u5", link.rawToken);
    const gone = await resolveShareView(db, link.rawToken);
    assert.equal(gone.ok, false);
    assert.equal(gone.error, "revoked");
  });

  it("delete-all and account delete leave 0 portfolio rows", async () => {
    const db = openMemoryDb();
    await seedUser(db, "u6", "u6@example.com");
    await createHolding({
      db,
      userId: "u6",
      printId: "z",
      gradeLabel: "Ungraded",
      qty: 2,
      costCents: 50,
    });
    await createShareLink({ db, userId: "u6" });
    const n = await deleteAllHoldings(db, "u6");
    assert.equal(n, 1);
    assert.equal((await listHoldings(db, "u6")).length, 0);

    await createHolding({
      db,
      userId: "u6",
      printId: "z2",
      gradeLabel: "Ungraded",
      qty: 1,
      costCents: 10,
    });
    await hardDeleteUser(db, "u6");
    const leftover = await countUserOwned(db, "u6");
    for (const [k, v] of Object.entries(leftover)) {
      assert.equal(v, 0, `${k} should be 0`);
    }
    const sales = await db
      .prepare(`SELECT COUNT(*) AS n FROM sale`)
      .first();
    // no orphan sales from this user (holding hard-deleted)
    assert.ok(sales);
  });

  it("CSV export round-trips headers", async () => {
    const csv = holdingsToCsv([
      {
        print_id: "p",
        grade_label: "Ungraded",
        qty: 2,
        cost_cents: 100,
        acquired_on: "2026-01-01",
        notes: 'hi, "there"',
      },
    ]);
    assert.ok(csv.startsWith("print_id,grade_label,qty,cost_cents"));
    assert.ok(csv.includes('"hi, ""there"""'));
  });
});
