/**
 * MeeTRPGが Webhook で送った告知文を読み取り、予定の一覧・リマインドを作る(Discordに触れない純粋関数)。
 *
 * 告知文の形(MeeTRPGの discordText と同じ):
 *   **【セッション確定】タイトル**            ← 候補日なら【候補日】
 *   日時: <t:開始:F> 〜 <t:終了:t>             ← 1件のとき
 *   参加: Aさん、Bさん
 *   ・パート名　<t:開始:F> 〜 <t:終了:t>（A、B） ← 複数件のとき
 */

export interface Session {
  /** 同じ予定を見分けるキー(タイトル+開始) */
  key: string;
  messageId: string;
  /** 告知が投稿された時刻(ミリ秒) */
  postedAt: number;
  title: string;
  start: number;
  end: number;
  members: string[];
  tentative: boolean;
}

export interface AnnouncementMessage {
  id: string;
  content: string;
  createdAt: number;
}

const HEAD = /^\*\*【(セッション確定|候補日)】(.+?)\*\*\s*$/;
const RANGE = /<t:(\d+):[a-zA-Z]>\s*〜\s*<t:(\d+):[a-zA-Z]>/;
const splitNames = (s: string) => s.split(/[、,，]/).map((x) => x.trim()).filter(Boolean);

/** 告知文1件を予定のリストにする。MeeTRPGの告知でなければ空 */
export function parseAnnouncement(msg: AnnouncementMessage): Session[] {
  const lines = msg.content.split('\n').map((l) => l.trim());
  const head = HEAD.exec(lines[0] ?? '');
  if (!head) return [];
  const tentative = head[1] === '候補日';
  const heading = head[2]!.trim();
  const out: Session[] = [];
  let single: Session | null = null;
  for (const line of lines.slice(1)) {
    const r = RANGE.exec(line);
    if (r) {
      const start = Number(r[1]) * 1000;
      let end = Number(r[2]) * 1000;
      if (end <= start) end += 24 * 3600 * 1000;
      if (line.startsWith('日時:')) {
        single = { key: '', messageId: msg.id, postedAt: msg.createdAt, title: heading, start, end, members: [], tentative };
        out.push(single);
      } else if (line.startsWith('・')) {
        const label = line.slice(1, r.index).trim();
        const mem = /（([^）]*)）\s*$/.exec(line.slice(r.index + r[0].length));
        out.push({
          key: '', messageId: msg.id, postedAt: msg.createdAt,
          title: label && label !== heading ? `${heading} ${label}` : heading,
          start, end, members: mem ? splitNames(mem[1]!) : [], tentative,
        });
      }
      continue;
    }
    if (single && line.startsWith('参加:')) single.members = splitNames(line.slice(3));
  }
  for (const s of out) s.key = `${s.title}|${s.start}`;
  return out;
}

/**
 * チャンネルの告知をまとめて予定にする。同じ予定が何度も告知されていたら、新しい告知を採用する
 * (候補日 → 確定 の順に送ったら、確定のほうが残る)。
 */
export function collectSessions(messages: AnnouncementMessage[]): Session[] {
  const byKey = new Map<string, Session>();
  for (const m of [...messages].sort((a, b) => a.createdAt - b.createdAt)) {
    for (const s of parseAnnouncement(m)) byKey.set(s.key, s);
  }
  return [...byKey.values()].sort((a, b) => a.start - b.start);
}

export function upcoming(sessions: Session[], now: number): Session[] {
  return sessions.filter((s) => s.end > now);
}

const ts = (ms: number, f: string) => `<t:${Math.floor(ms / 1000)}:${f}>`;

/** /次回 の返事 */
export function nextText(sessions: Session[], now: number, limit = 5): string {
  const up = upcoming(sessions, now);
  if (!up.length) return '予定されているセッションはありません。';
  const [first, ...rest] = up;
  const out = [`**次回のセッション**${first!.tentative ? '（候補日）' : ''}`, `**${first!.title}**`, `${ts(first!.start, 'F')} 〜 ${ts(first!.end, 't')}（${ts(first!.start, 'R')}）`];
  if (first!.members.length) out.push(`参加: ${first!.members.join('、')}`);
  const more = rest.slice(0, limit - 1);
  if (more.length) {
    out.push('', '**そのあとの予定**');
    for (const s of more) out.push(`・${ts(s.start, 'f')}　${s.title}${s.tentative ? '（候補）' : ''}`);
  }
  if (rest.length > more.length) out.push(`ほか ${rest.length - more.length} 件`);
  return out.join('\n');
}

export interface ReminderPlan {
  /** 送るリマインド */
  send: { session: Session; minutes: number; key: string }[];
  /** 送らずに「送った扱い」にするキー(告知が遅かった、botが止まっていた等) */
  skip: string[];
}

export const reminderKey = (s: Session, minutes: number) => `${s.messageId}|${s.key}|${minutes}`;

/**
 * いま送るべきリマインドを決める。
 * - 確定した予定だけ(候補日は送らない)
 * - 「開始の minutes 分前」を過ぎ、まだ開始していなければ送る
 * - 同じ予定で複数のタイミングがたまっていたら、いちばん直前のものだけ送る
 * - 告知そのものがそのタイミングより後だったら送らない(告知直後に重ねて送らないため)
 */
export function planReminders(sessions: Session[], now: number, minutesList: number[], sent: Set<string>): ReminderPlan {
  const plan: ReminderPlan = { send: [], skip: [] };
  const mins = [...new Set(minutesList)].filter((m) => m > 0).sort((a, b) => a - b);
  for (const s of sessions) {
    if (s.tentative || now >= s.start) continue;
    const due = mins.filter((m) => now >= s.start - m * 60_000 && !sent.has(reminderKey(s, m)));
    if (!due.length) continue;
    const [nearest, ...older] = due;
    plan.skip.push(...older.map((m) => reminderKey(s, m)));
    if (s.postedAt >= s.start - nearest! * 60_000) plan.skip.push(reminderKey(s, nearest!));
    else plan.send.push({ session: s, minutes: nearest!, key: reminderKey(s, nearest!) });
  }
  return plan;
}

function beforeLabel(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? '明日' : `${minutes / 1440}日後`;
  if (minutes % 60 === 0) return `${minutes / 60}時間後`;
  return `${minutes}分後`;
}

export function reminderText(s: Session, minutes: number, roleId: string | null): string {
  const out = [`${roleId ? `<@&${roleId}> ` : ''}**【リマインド】${beforeLabel(minutes)}はセッションです**`, `**${s.title}**`, `${ts(s.start, 'F')} 〜 ${ts(s.end, 't')}（${ts(s.start, 'R')}）`];
  if (s.members.length) out.push(`参加: ${s.members.join('、')}`);
  return out.join('\n');
}

/** .env の REMIND_MINUTES("1440,60" の形)を読む。空なら リマインドしない */
export function parseMinutes(v: string | undefined): number[] {
  if (v === undefined) return [1440, 60];
  return v.split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
}
