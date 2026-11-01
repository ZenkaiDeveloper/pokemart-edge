/** Daily cron: evaluate rules then deliver pending events (10:00 UTC). */
import type { DbPort } from "../ports/db";
import type { EmailPort } from "../email";
import { evaluateAlerts, estimateDailyWrites, type EvalStats } from "./evaluate";
import { deliverPending, type DeliverStats } from "./deliver";

export type CronResult = {
  ok: true;
  evaluate: EvalStats;
  deliver: DeliverStats;
  write_budget_sim_1000x10: number;
  write_budget_ok: boolean;
};

export async function runAlertsCron(
  db: DbPort,
  opts: {
    emailPort: EmailPort;
    encSecret: string;
    siteOrigin: string;
    now?: Date;
  },
): Promise<CronResult> {
  const evaluate = await evaluateAlerts(db, { now: opts.now });
  const deliver = await deliverPending(db, {
    emailPort: opts.emailPort,
    encSecret: opts.encSecret,
    siteOrigin: opts.siteOrigin,
    now: opts.now,
  });
  const sim = estimateDailyWrites(1000, 10);
  // Acceptance: daily D1 writes <= 10k at 1,000 users × 10 rules (event+delivery).
  const write_budget_ok = sim <= 10_000;
  console.log(
    JSON.stringify({
      msg: "alerts_cron",
      evaluate,
      deliver,
      write_budget_sim_1000x10: sim,
      write_budget_ok,
    }),
  );
  return {
    ok: true,
    evaluate,
    deliver,
    write_budget_sim_1000x10: sim,
    write_budget_ok,
  };
}
