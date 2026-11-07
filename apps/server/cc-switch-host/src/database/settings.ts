/** Translated from vendor/cc-switch/src-tauri/src/database/dao/settings.rs. */
import type { DatabaseSync } from "node:sqlite";

export class SettingsDao {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  get(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM settings WHERE key = ?1").get(key) as { value?: string } | undefined;
    return row?.value;
  }

  getBool(key: string): boolean {
    const value = this.get(key);
    return value === "true" || value === "1";
  }

  set(key: string, value: string): void {
    this.#db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)").run(key, value);
  }

  delete(key: string): void {
    this.#db.prepare("DELETE FROM settings WHERE key = ?1").run(key);
  }
}
