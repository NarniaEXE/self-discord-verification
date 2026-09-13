import dotenv from "dotenv";

dotenv.config();

export const PORT = process.env.PORT || 8080;
console.log("PORT", PORT);

export const SELF_ENDPOINT = process.env.SELF_ENDPOINT;
console.log("SELF_ENDPOINT", SELF_ENDPOINT);

export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
export const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
export const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
export const DISCORD_VERIFIED_ROLE_ID = process.env.DISCORD_VERIFIED_ROLE_ID;
export const DISCORD_LOG_CHANNEL_ID = process.env.DISCORD_LOG_CHANNEL_ID;

export const SELF_APP_NAME =
  process.env.SELF_APP_NAME || "Self Discord Verification Hardcoded";
console.log("SELF_APP_NAME", SELF_APP_NAME);
export const SELF_LOGO_URL =
  process.env.SELF_LOGO_URL || "https://i.postimg.cc/mrmVf9hm/self.png";
