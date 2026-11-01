/**
 * Generic CSV import with column mapping. Does not promise Collectr/TCG formats.
 */
import type { DbPort } from "../ports/db";
import { createHolding } from "./holdings";

export type CsvMapping = {
  print_id: string; // header name
  grade_label?: string;
  qty?: string;
  cost_cents?: string;
  cost_dollars?: string;
  acquired_on?: string;
  notes?: string;
};

export type ImportResult = {
  ok: true;
  imported: number;
  skipped: number;
  errors: string[];
  ms: number;
};

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length);
  if (!lines.length) return { headers: [], rows: [] };
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQ = false;
          }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };
  const headers = split(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map(split);
  return { headers, rows };
}

function colIndex(headers: string[], name: string | undefined): number {
  if (!name) return -1;
  const want = name.trim().toLowerCase();
  return headers.findIndex((h) => h.trim().toLowerCase() === want);
}

export async function importCsvHoldings(opts: {
  db: DbPort;
  userId: string;
  csvText: string;
  mapping: CsvMapping;
  now?: Date;
}): Promise<ImportResult> {
  const t0 = Date.now();
  const { headers, rows } = parseCsv(opts.csvText);
  const errors: string[] = [];
  if (!headers.length) {
    return {
      ok: true,
      imported: 0,
      skipped: 0,
      errors: ["empty_csv"],
      ms: Date.now() - t0,
    };
  }
  const iPrint = colIndex(headers, opts.mapping.print_id);
  if (iPrint < 0) {
    return {
      ok: true,
      imported: 0,
      skipped: rows.length,
      errors: [`missing_column:${opts.mapping.print_id}`],
      ms: Date.now() - t0,
    };
  }
  const iGrade = colIndex(headers, opts.mapping.grade_label);
  const iQty = colIndex(headers, opts.mapping.qty);
  const iCostC = colIndex(headers, opts.mapping.cost_cents);
  const iCostD = colIndex(headers, opts.mapping.cost_dollars);
  const iAcq = colIndex(headers, opts.mapping.acquired_on);
  const iNotes = colIndex(headers, opts.mapping.notes);

  let imported = 0;
  let skipped = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const printId = String(row[iPrint] || "").trim();
    if (!printId) {
      skipped += 1;
      continue;
    }
    const grade =
      iGrade >= 0 ? String(row[iGrade] || "").trim() || "Ungraded" : "Ungraded";
    const qty =
      iQty >= 0 ? Math.max(1, Math.round(Number(row[iQty]) || 1)) : 1;
    let cost: number | null = null;
    if (iCostC >= 0 && String(row[iCostC] || "").trim() !== "") {
      cost = Math.round(Number(row[iCostC]));
    } else if (iCostD >= 0 && String(row[iCostD] || "").trim() !== "") {
      cost = Math.round(Number(row[iCostD]) * 100);
    }
    if (cost != null && !Number.isFinite(cost)) {
      skipped += 1;
      if (errors.length < 20) errors.push(`row_${r + 2}:bad_cost`);
      continue;
    }
    const res = await createHolding({
      db: opts.db,
      userId: opts.userId,
      printId,
      gradeLabel: grade,
      qty,
      costCents: cost,
      acquiredOn: iAcq >= 0 ? String(row[iAcq] || "").trim() || null : null,
      notes: iNotes >= 0 ? String(row[iNotes] || "").trim() || null : null,
      now: opts.now,
    });
    if (res.ok) imported += 1;
    else {
      skipped += 1;
      if (errors.length < 20) errors.push(`row_${r + 2}:${res.error}`);
    }
  }
  return {
    ok: true,
    imported,
    skipped,
    errors,
    ms: Date.now() - t0,
  };
}

export function holdingsToCsv(
  rows: Array<{
    print_id: string;
    grade_label: string;
    qty: number;
    cost_cents: number | null;
    acquired_on?: string | null;
    notes?: string | null;
  }>,
): string {
  const esc = (v: string) => {
    if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };
  const lines = [
    "print_id,grade_label,qty,cost_cents,acquired_on,notes",
  ];
  for (const r of rows) {
    lines.push(
      [
        esc(r.print_id),
        esc(r.grade_label),
        String(r.qty),
        r.cost_cents == null ? "" : String(r.cost_cents),
        esc(r.acquired_on || ""),
        esc(r.notes || ""),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
