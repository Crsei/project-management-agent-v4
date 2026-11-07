/** Translated from vendor/cc-switch/src-tauri/src/database/dao/skills.rs. */
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_SKILL_REPOS } from "../constants.ts";
import { databaseError } from "../errors.ts";
import { APP_IDS, emptyAppFlags, type AppId, type AppFlags, type InstalledSkill, type SkillRepo } from "../types.ts";

const SELECT = `SELECT id, name, description, directory, repo_owner, repo_name, repo_branch,
 readme_url, enabled_claude, enabled_codex, enabled_gemini, enabled_grokbuild,
 enabled_opencode, enabled_hermes, installed_at, content_hash, updated_at,
 enabled_mcode, enabled_agy, enabled_kimi, enabled_dsh FROM skills`;

type Row = Record<string, unknown>;

function bool(row: Row, key: string): boolean {
  return row[key] === 1 || row[key] === true || row[key] === "1";
}

function rowToSkill(row: Row): InstalledSkill {
  const apps = emptyAppFlags();
  for (const app of APP_IDS) {
    // Pi/OMP skill flags are native-directory observations, not database columns.
    apps[app] = app === "pi" || app === "omp" ? false : bool(row, `enabled_${app}`);
  }
  return {
    id: String(row.id),
    name: String(row.name),
    ...(row.description != null ? { description: String(row.description) } : {}),
    directory: String(row.directory),
    ...(row.repo_owner != null ? { repoOwner: String(row.repo_owner) } : {}),
    ...(row.repo_name != null ? { repoName: String(row.repo_name) } : {}),
    ...(row.repo_branch != null ? { repoBranch: String(row.repo_branch) } : {}),
    ...(row.readme_url != null ? { readmeUrl: String(row.readme_url) } : {}),
    apps,
    installedAt: Number(row.installed_at ?? 0),
    ...(row.content_hash != null ? { contentHash: String(row.content_hash) } : {}),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

export class SkillsDao {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  getAllInstalled(): Map<string, InstalledSkill> {
    const rows = this.#db.prepare(`${SELECT} ORDER BY name ASC`).all() as Row[];
    return new Map(rows.map((row) => [String(row.id), rowToSkill(row)]));
  }

  getInstalled(id: string): InstalledSkill | undefined {
    const row = this.#db.prepare(`${SELECT} WHERE id = ?1`).get(id) as Row | undefined;
    return row ? rowToSkill(row) : undefined;
  }

  save(skill: InstalledSkill): void {
    this.#db.prepare(`INSERT OR REPLACE INTO skills
      (id, name, description, directory, repo_owner, repo_name, repo_branch,
       readme_url, enabled_claude, enabled_codex, enabled_gemini, enabled_grokbuild,
       enabled_opencode, enabled_hermes, installed_at, content_hash, updated_at,
       enabled_mcode, enabled_agy, enabled_kimi, enabled_dsh)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`)
      .run(
        skill.id, skill.name, skill.description ?? null, skill.directory, skill.repoOwner ?? null,
        skill.repoName ?? null, skill.repoBranch ?? null, skill.readmeUrl ?? null,
        skill.apps.claude ? 1 : 0, skill.apps.codex ? 1 : 0, skill.apps.gemini ? 1 : 0,
        skill.apps.grokbuild ? 1 : 0, skill.apps.opencode ? 1 : 0, skill.apps.hermes ? 1 : 0,
        skill.installedAt, skill.contentHash ?? null, skill.updatedAt,
        skill.apps.mcode ? 1 : 0, skill.apps.agy ? 1 : 0, skill.apps.kimi ? 1 : 0, skill.apps.dsh ? 1 : 0,
      );
  }

  updateMetadata(skill: InstalledSkill): boolean {
    const result = this.#db.prepare(`UPDATE skills SET name=?1, description=?2, directory=?3,
      repo_owner=?4, repo_name=?5, repo_branch=?6, readme_url=?7, installed_at=?8,
      content_hash=?9, updated_at=?10 WHERE id=?11 AND installed_at=?12`)
      .run(skill.name, skill.description ?? null, skill.directory, skill.repoOwner ?? null,
        skill.repoName ?? null, skill.repoBranch ?? null, skill.readmeUrl ?? null,
        skill.installedAt, skill.contentHash ?? null, skill.updatedAt, skill.id, skill.installedAt);
    return Number(result.changes) > 0;
  }

  delete(id: string): boolean {
    return Number(this.#db.prepare("DELETE FROM skills WHERE id = ?1").run(id).changes) > 0;
  }

  clear(): void {
    this.#db.prepare("DELETE FROM skills").run();
  }

  updateApps(id: string, apps: AppFlags): boolean {
    const result = this.#db.prepare(`UPDATE skills SET enabled_claude=?1, enabled_codex=?2,
      enabled_gemini=?3, enabled_grokbuild=?4, enabled_opencode=?5, enabled_hermes=?6,
      enabled_mcode=?8, enabled_agy=?9, enabled_kimi=?10, enabled_dsh=?11 WHERE id=?7`)
      .run(apps.claude ? 1 : 0, apps.codex ? 1 : 0, apps.gemini ? 1 : 0, apps.grokbuild ? 1 : 0,
        apps.opencode ? 1 : 0, apps.hermes ? 1 : 0, id, apps.mcode ? 1 : 0, apps.agy ? 1 : 0,
        apps.kimi ? 1 : 0, apps.dsh ? 1 : 0);
    return Number(result.changes) > 0;
  }

  updateHash(id: string, contentHash: string, updatedAt: number): boolean {
    return Number(this.#db.prepare("UPDATE skills SET content_hash=?1, updated_at=?2 WHERE id=?3").run(contentHash, updatedAt, id).changes) > 0;
  }

  getRepos(): SkillRepo[] {
    const rows = this.#db.prepare("SELECT owner, name, branch, enabled FROM skill_repos ORDER BY owner ASC, name ASC").all() as Row[];
    return rows.map((row) => ({
      owner: String(row.owner),
      name: String(row.name),
      branch: String(row.branch ?? "main"),
      enabled: bool(row, "enabled"),
    }));
  }

  saveRepo(repo: SkillRepo): void {
    this.#db.prepare("INSERT OR REPLACE INTO skill_repos (owner, name, branch, enabled) VALUES (?1, ?2, ?3, ?4)")
      .run(repo.owner, repo.name, repo.branch, repo.enabled ? 1 : 0);
  }

  deleteRepo(owner: string, name: string): void {
    this.#db.prepare("DELETE FROM skill_repos WHERE owner = ?1 AND name = ?2").run(owner, name);
  }

  initDefaultRepos(): number {
    const initialized = "default_skill_repos_initialized";
    const settings = this.#db.prepare("SELECT value FROM settings WHERE key = ?1").get(initialized) as { value?: string } | undefined;
    if (settings?.value === "true" || settings?.value === "1") return 0;
    if (this.getRepos().length > 0) {
      this.#db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, 'true')").run(initialized);
      return 0;
    }
    let count = 0;
    for (const repo of DEFAULT_SKILL_REPOS) {
      this.saveRepo({ ...repo });
      count += 1;
    }
    this.#db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, 'true')").run(initialized);
    return count;
  }

  /** Compatibility helper for callers that need an error boundary. */
  fail(message: string): never {
    throw databaseError(message);
  }
}

export type { AppId };
