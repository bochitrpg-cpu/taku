import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Node標準の node:sqlite を使う(ビルドが要らないので、Windowsでも追加のインストールなしで動く) */
export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS guilds (
      guild_id   TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      webhook_id TEXT NOT NULL,
      role_id    TEXT
    );
    CREATE TABLE IF NOT EXISTS reminders_sent (
      key     TEXT PRIMARY KEY,
      sent_at INTEGER NOT NULL
    );
  `);
  return db;
}

export interface GuildSetting {
  guildId: string;
  /** MeeTRPGの告知が届くチャンネル(リマインドもここに出す) */
  channelId: string;
  /** MeeTRPGが使う Webhook。このWebhookの投稿だけを告知として読む */
  webhookId: string;
  /** リマインドでメンションするロール */
  roleId: string | null;
}

export class Repo {
  constructor(private db: DatabaseSync) {}

  getGuild(guildId: string): GuildSetting | null {
    const r = this.db.prepare('SELECT * FROM guilds WHERE guild_id = ?').get(guildId) as Record<string, string | null> | undefined;
    return r ? toSetting(r) : null;
  }
  allGuilds(): GuildSetting[] {
    return (this.db.prepare('SELECT * FROM guilds').all() as Record<string, string | null>[]).map(toSetting);
  }
  setGuild(s: GuildSetting) {
    this.db
      .prepare(
        `INSERT INTO guilds (guild_id, channel_id, webhook_id, role_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id, webhook_id = excluded.webhook_id, role_id = excluded.role_id`,
      )
      .run(s.guildId, s.channelId, s.webhookId, s.roleId);
  }
  removeGuild(guildId: string) {
    this.db.prepare('DELETE FROM guilds WHERE guild_id = ?').run(guildId);
  }

  sentKeys(): Set<string> {
    return new Set((this.db.prepare('SELECT key FROM reminders_sent').all() as { key: string }[]).map((r) => r.key));
  }
  markSent(keys: string[], now: number) {
    const st = this.db.prepare('INSERT OR IGNORE INTO reminders_sent (key, sent_at) VALUES (?, ?)');
    for (const k of keys) st.run(k, now);
  }
  /** 古い送信記録を消す(30日より前) */
  pruneSent(now: number) {
    this.db.prepare('DELETE FROM reminders_sent WHERE sent_at < ?').run(now - 30 * 86400_000);
  }
}

function toSetting(r: Record<string, string | null>): GuildSetting {
  return { guildId: r['guild_id']!, channelId: r['channel_id']!, webhookId: r['webhook_id']!, roleId: r['role_id'] ?? null };
}
