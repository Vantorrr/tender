import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, ensureReady, mutateAppData, readAppData } from "@/server/db";
import "./setup";

describe("schema 11 plan/fact heal from dailyFacts", () => {
  afterEach(() => {
    closeDb();
  });

  it("migrate 10→11 recomputes stale entry.fact=0 when daily sum=2", () => {
    closeDb();
    ensureReady();
    mutateAppData((d) => {
      const pf = d.planFacts[0];
      const name = pf.entries[0].workName;
      const unit = pf.entries[0].unit;
      pf.dailyFacts = [
        {
          id: "df-heal-1",
          date: "2026-11-08",
          workName: name,
          unit,
          quantity: 1,
          photos: [],
          authorId: "u-obj",
          at: new Date().toISOString(),
        },
        {
          id: "df-heal-2",
          date: "2026-11-08",
          workName: name,
          unit,
          quantity: 1,
          photos: [],
          authorId: "u-obj",
          at: new Date().toISOString(),
        },
      ];
      pf.entries[0].fact = 0;
      pf.entries[0].contractRemaining = pf.entries[0].plan;
      return d;
    });
    closeDb();
    const dbPath = path.join(
      process.env.DATA_DIR || "data",
      process.env.DB_FILE || "app.sqlite"
    );
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(
      "10",
      "schema_version"
    );
    db.close();
    ensureReady(); // bumps to 11 + applySchema extras → recompute
    const pf = readAppData().planFacts[0];
    const e = pf.entries[0];
    const day = (pf.dailyFacts ?? [])
      .filter((d) => d.workName === e.workName)
      .reduce((s, d) => s + d.quantity, 0);
    expect(day).toBe(2);
    expect(e.fact).toBe(2);
    expect(e.contractRemaining).toBe(Math.max(0, e.plan - 2));
  });
});
