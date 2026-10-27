import 'dotenv/config';
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits as P,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
  type Message,
} from 'discord.js';
import { collectSessions, nextText, parseMinutes, planReminders, reminderText, type AnnouncementMessage } from './core/sessions.js';
import { openDb, Repo, type GuildSetting } from './db.js';

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`環境変数 ${name} が設定されていません。.env を確認してください。`);
    process.exit(1);
  }
  return v;
}

const token = need('DISCORD_TOKEN');
const repo = new Repo(openDb(process.env['DATABASE_PATH'] ?? './data/app.db'));
const remindMinutes = parseMinutes(process.env['REMIND_MINUTES']);
/** 告知を読みにいく、さかのぼるメッセージ数の上限(100件ずつ) */
const HISTORY_PAGES = 5;
const WEBHOOK_NAME = 'MeeTRPG';

const commands = [
  new SlashCommandBuilder()
    .setName('告知先')
    .setDescription('このチャンネルをMeeTRPGの告知先にして、MeeTRPGに入れるWebhook URLを出します')
    .addRoleOption((o) => o.setName('ロール').setDescription('リマインドでメンションするロール(任意)'))
    .setDefaultMemberPermissions(P.ManageGuild)
    .setDMPermission(false),
  new SlashCommandBuilder().setName('次回').setDescription('次のセッションの日時を表示します').setDMPermission(false),
];

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once(Events.ClientReady, async (c) => {
  console.log(`bot ログイン完了: ${c.user.tag} / 参加サーバー ${c.guilds.cache.size} 件`);
  await c.application.commands.set(commands.map((x) => x.toJSON()));
  console.log('コマンド /告知先 /次回 を登録しました');
  if (remindMinutes.length) {
    console.log(`リマインド: 開始の ${remindMinutes.map((m) => `${m}分`).join('・')}前`);
    void remindTick();
    setInterval(() => void remindTick(), 60_000);
  } else console.log('リマインドはオフです(REMIND_MINUTES が空)');
});

client.on(Events.InteractionCreate, async (it) => {
  if (!it.isChatInputCommand() || !it.inCachedGuild()) return;
  try {
    if (it.commandName === '告知先') await onSetChannel(it);
    else if (it.commandName === '次回') await onNext(it);
  } catch (e) {
    console.error(e);
    const content = `うまくいきませんでした: ${(e as Error).message}`;
    if (it.deferred || it.replied) await it.editReply({ content }).catch(() => {});
    else await it.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

async function onSetChannel(it: ChatInputCommandInteraction<'cached'>) {
  await it.deferReply({ flags: MessageFlags.Ephemeral });
  const ch = it.channel;
  if (!ch || ch.type !== ChannelType.GuildText) {
    await it.editReply('普通のテキストチャンネルで実行してください(スレッドやボイスチャンネルは使えません)。');
    return;
  }
  const me = it.guild.members.me;
  const perms = me && ch.permissionsFor(me);
  const lacking = [
    [P.ViewChannel, 'チャンネルを見る'],
    [P.SendMessages, 'メッセージを送信'],
    [P.ReadMessageHistory, 'メッセージ履歴を読む'],
    [P.ManageWebhooks, 'ウェブフックの管理'],
  ].filter(([bit]) => !perms?.has(bit as bigint)).map(([, name]) => name);
  if (lacking.length) {
    await it.editReply(`このチャンネルで、botに次の権限がありません: ${lacking.join('、')}\nbotのロールかチャンネルの権限設定で許可してから、もう一度実行してください。`);
    return;
  }
  // 同じチャンネルに前に作ったWebhookがあれば使い回す(MeeTRPGに入れたURLが変わらないように)
  const old = repo.getGuild(it.guildId);
  const hooks = await ch.fetchWebhooks();
  let hook = hooks.find((h) => h.id === old?.webhookId) ?? hooks.find((h) => h.owner?.id === client.user?.id && h.name === WEBHOOK_NAME);
  if (!hook) hook = await ch.createWebhook({ name: WEBHOOK_NAME, reason: 'MeeTRPGからの告知用' });
  const role = it.options.getRole('ロール');
  repo.setGuild({ guildId: it.guildId, channelId: ch.id, webhookId: hook.id, roleId: role?.id ?? null });
  await it.editReply(
    [
      `このチャンネル(<#${ch.id}>)を告知先にしました。${role ? `リマインドでは <@&${role.id}> をメンションします。` : ''}`,
      'MeeTRPGの「Discord連携」に、次のURLを貼り付けてください(このURLは他の人に見せないでください)。',
      '```',
      hook.url,
      '```',
    ].join('\n'),
  );
}

async function onNext(it: ChatInputCommandInteraction<'cached'>) {
  const g = repo.getGuild(it.guildId);
  if (!g) {
    await it.reply({ content: 'まだ告知先が決まっていません。管理者が告知用のチャンネルで /告知先 を実行してください。', flags: MessageFlags.Ephemeral });
    return;
  }
  await it.deferReply();
  const sessions = collectSessions(await fetchAnnouncements(g));
  await it.editReply({ content: nextText(sessions, Date.now()), allowedMentions: { parse: [] } });
}

/** 告知先チャンネルから、MeeTRPGのWebhookの投稿だけを集める */
async function fetchAnnouncements(g: GuildSetting): Promise<AnnouncementMessage[]> {
  const ch = await client.channels.fetch(g.channelId).catch(() => null);
  if (!ch || !ch.isTextBased() || ch.isDMBased()) throw new Error('告知先のチャンネルが見つかりません。/告知先 をもう一度実行してください。');
  const out: AnnouncementMessage[] = [];
  let before: string | undefined;
  for (let i = 0; i < HISTORY_PAGES; i++) {
    const page = await (ch as GuildTextBasedChannel).messages.fetch({ limit: 100, before });
    for (const m of page.values()) if (m.webhookId === g.webhookId) out.push(toAnnouncement(m));
    if (page.size < 100) break;
    before = page.lastKey();
  }
  return out;
}

function toAnnouncement(m: Message): AnnouncementMessage {
  return { id: m.id, content: m.content, createdAt: m.createdTimestamp };
}

let ticking = false;
async function remindTick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const sent = repo.sentKeys();
    for (const g of repo.allGuilds()) {
      try {
        const sessions = collectSessions(await fetchAnnouncements(g));
        const plan = planReminders(sessions, now, remindMinutes, sent);
        repo.markSent(plan.skip, now);
        if (!plan.send.length) continue;
        const ch = await client.channels.fetch(g.channelId);
        if (!ch?.isSendable()) continue;
        for (const r of plan.send) {
          await ch.send({ content: reminderText(r.session, r.minutes, g.roleId), allowedMentions: { roles: g.roleId ? [g.roleId] : [] } });
          repo.markSent([r.key], now);
          console.log(`リマインド送信: ${r.session.title}(${r.minutes}分前)`);
        }
      } catch (e) {
        console.error(`リマインドの確認に失敗(サーバー ${g.guildId}):`, (e as Error).message);
      }
    }
    repo.pruneSent(now);
  } finally {
    ticking = false;
  }
}

await client.login(token);
