import 'dotenv/config';
import { OAuth2Scopes, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';

const clientId = process.env['DISCORD_CLIENT_ID'];
if (!clientId) {
  console.error('DISCORD_CLIENT_ID が設定されていません。.env を確認してください。');
  process.exit(1);
}
/** 告知を読む・リマインドを送る・Webhookを作るのに要る権限 */
const bits = new PermissionsBitField([P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageWebhooks, P.MentionEveryone]).bitfield;
const scopes = [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands].join('%20');
console.log(`https://discord.com/oauth2/authorize?client_id=${clientId}&scope=${scopes}&permissions=${bits}`);
