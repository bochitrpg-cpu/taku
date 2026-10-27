import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectSessions, nextText, parseAnnouncement, parseMinutes, planReminders, reminderText } from '../src/core/sessions.js';
import { openDb, Repo } from '../src/db.js';

const H = 3600_000;
const T0 = Date.UTC(2026, 10, 1, 12, 0); // 2026-11-01 21:00 JST
const t = (ms: number) => Math.floor(ms / 1000);

const single = (id: string, at: number, start = T0, head = 'セッション確定') => ({
  id,
  createdAt: at,
  content: [`**【${head}】紅の館**`, `日時: <t:${t(start)}:F> 〜 <t:${t(start + 3 * H)}:t>`, '参加: KPぼち、HO1かき、HO2くり', 'ボイスあり'].join('\n'),
});
const multi = (id: string, at: number) => ({
  id,
  createdAt: at,
  content: [
    '**【セッション確定】紅の館**',
    `・KPHO1　<t:${t(T0)}:F> 〜 <t:${t(T0 + H)}:t>（KPぼち、HO1かき）`,
    `・全員　<t:${t(T0 + 24 * H)}:F> 〜 <t:${t(T0 + 28 * H)}:t>（KPぼち、HO1かき、HO2くり）`,
  ].join('\n'),
});

describe('告知文の読み取り', () => {
  it('1件の告知', () => {
    const [s, ...rest] = parseAnnouncement(single('m1', T0 - 48 * H));
    assert.equal(rest.length, 0);
    assert.equal(s!.title, '紅の館');
    assert.equal(s!.start, T0);
    assert.equal(s!.end, T0 + 3 * H);
    assert.deepEqual(s!.members, ['KPぼち', 'HO1かき', 'HO2くり']);
    assert.equal(s!.tentative, false);
  });
  it('複数パートの告知', () => {
    const list = parseAnnouncement(multi('m2', T0 - 48 * H));
    assert.deepEqual(list.map((s) => s.title), ['紅の館 KPHO1', '紅の館 全員']);
    assert.deepEqual(list[0]!.members, ['KPぼち', 'HO1かき']);
    assert.equal(list[1]!.end - list[1]!.start, 4 * H);
  });
  it('候補日', () => {
    const m = single('m3', 0, T0, '候補日');
    m.content = m.content.replace('\n', '\nくり さんの参加が決まれば確定です\n');
    const [s] = parseAnnouncement(m);
    assert.equal(s!.tentative, true);
  });
  it('MeeTRPGの告知でないものは無視', () => {
    assert.deepEqual(parseAnnouncement({ id: 'x', createdAt: 0, content: 'こんにちは <t:1:F> 〜 <t:2:t>' }), []);
    assert.deepEqual(parseAnnouncement({ id: 'x', createdAt: 0, content: '**【日程まとめ】紅の館**\n・<t:1:F> 〜 <t:2:t>　紅の館' }), []);
  });
  it('0時をまたぐ終了は翌日として扱う', () => {
    const m = { id: 'x', createdAt: 0, content: `**【セッション確定】夜**\n日時: <t:${t(T0)}:F> 〜 <t:${t(T0 - 21 * H)}:t>` };
    assert.equal(parseAnnouncement(m)[0]!.end, T0 + 3 * H);
  });
  it('候補日のあとに確定を送ったら、確定が残る', () => {
    const list = collectSessions([single('new', T0 - 24 * H), single('old', T0 - 48 * H, T0, '候補日')]);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.messageId, 'new');
    assert.equal(list[0]!.tentative, false);
  });
});

describe('/次回', () => {
  it('次の予定とそのあとの予定', () => {
    const text = nextText(collectSessions([multi('m2', T0 - 48 * H)]), T0 - H);
    assert.match(text, /\*\*紅の館 KPHO1\*\*/);
    assert.match(text, /そのあとの予定\*\*\n・<t:\d+:f>　紅の館 全員/);
  });
  it('終わった予定は出さない', () => {
    assert.equal(nextText(collectSessions([single('m1', 0)]), T0 + 4 * H), '予定されているセッションはありません。');
  });
});

describe('リマインド', () => {
  const S = collectSessions([single('m1', T0 - 72 * H)]);
  it('時刻が来たら送る', () => {
    assert.equal(planReminders(S, T0 - 25 * H, [1440, 60], new Set()).send.length, 0);
    const p = planReminders(S, T0 - 24 * H + 1, [1440, 60], new Set());
    assert.deepEqual(p.send.map((x) => x.minutes), [1440]);
  });
  it('送ったものは二度送らない', () => {
    const p1 = planReminders(S, T0 - 23 * H, [1440, 60], new Set());
    const p2 = planReminders(S, T0 - 23 * H, [1440, 60], new Set(p1.send.map((x) => x.key)));
    assert.equal(p2.send.length, 0);
  });
  it('止まっていて複数たまったら、直前のものだけ送る', () => {
    const p = planReminders(S, T0 - 30 * 60_000, [1440, 60], new Set());
    assert.deepEqual(p.send.map((x) => x.minutes), [60]);
    assert.equal(p.skip.length, 1);
  });
  it('開始後は送らない', () => {
    assert.equal(planReminders(S, T0 + 1, [1440, 60], new Set()).send.length, 0);
  });
  it('告知が直前だったら、前日のリマインドは送らない', () => {
    const late = collectSessions([single('m9', T0 - 5 * H)]);
    const p = planReminders(late, T0 - 5 * H + 60_000, [1440, 60], new Set());
    assert.equal(p.send.length, 0);
    assert.equal(p.skip.length, 1);
  });
  it('候補日には送らない', () => {
    const tent = collectSessions([single('m3', T0 - 72 * H, T0, '候補日')]);
    assert.equal(planReminders(tent, T0 - 30 * 60_000, [1440, 60], new Set()).send.length, 0);
  });
  it('文面とロールのメンション', () => {
    assert.match(reminderText(S[0]!, 1440, null), /^\*\*【リマインド】明日はセッションです\*\*\n\*\*紅の館\*\*/);
    assert.match(reminderText(S[0]!, 60, '123'), /^<@&123> \*\*【リマインド】1時間後/);
  });
  it('REMIND_MINUTES', () => {
    assert.deepEqual(parseMinutes(undefined), [1440, 60]);
    assert.deepEqual(parseMinutes(''), []);
    assert.deepEqual(parseMinutes('1440, 30'), [1440, 30]);
  });
});

describe('DB', () => {
  it('サーバー設定と送信記録', () => {
    const repo = new Repo(openDb(':memory:'));
    repo.setGuild({ guildId: 'g', channelId: 'c', webhookId: 'w', roleId: null });
    repo.setGuild({ guildId: 'g', channelId: 'c2', webhookId: 'w2', roleId: 'r' });
    assert.deepEqual(repo.getGuild('g'), { guildId: 'g', channelId: 'c2', webhookId: 'w2', roleId: 'r' });
    assert.equal(repo.allGuilds().length, 1);
    repo.markSent(['a', 'a', 'b'], 0);
    assert.deepEqual([...repo.sentKeys()].sort(), ['a', 'b']);
    repo.pruneSent(31 * 86400_000);
    assert.equal(repo.sentKeys().size, 0);
  });
});
