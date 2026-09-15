import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
  ActivityType,
} from "discord.js";
import QRCode from "qrcode";

import {
  SELF_ENDPOINT,
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  DISCORD_VERIFIED_ROLE_ID,
  DISCORD_LOG_CHANNEL_ID,
  DISCORD_ALERTS_CHANNEL_ID,
  DISCORD_ADMIN_USER_ID,
  SELF_APP_NAME,
  SELF_LOGO_URL,
} from "./config.mjs";
import { logEvent, LOG_FILE_PATH } from "./logger.mjs";
import { createShortUrl } from "./urlShortener.mjs";
import { removeIdentityByDiscordUserId } from "./identityTracker.mjs";

const require = createRequire(import.meta.url);
const { SelfAppBuilder, getUniversalLink } = require("@selfxyz/common");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");

const qrOutputDir = path.join(rootDir, "qrcodes");
fs.mkdirSync(qrOutputDir, { recursive: true });

const QR_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

function cleanupStaleQrFiles() {
  fs.readdir(qrOutputDir, (readErr, files) => {
    if (readErr) return;

    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(qrOutputDir, file);
      fs.stat(filePath, (statErr, stats) => {
        if (statErr) return;
        if (now - stats.mtimeMs > QR_MAX_AGE_MS) {
          fs.unlink(filePath, () => {});
        }
      });
    }
  });
}

setInterval(cleanupStaleQrFiles, 30 * 60 * 1000); // sweep every 30 minutes

const pendingVerifications = new Map();
let discordClient = null;

export function getDiscordClient() {
  return discordClient;
}

export function getPendingVerifications() {
  return [...pendingVerifications.entries()].map(([sessionId, data]) => ({
    sessionId,
    discordUserId: data.discordUserId,
    createdAt: data.createdAt,
  }));
}

async function createSelfVerificationLink(sessionId, discordUser, generateQr = true, isMobile = false) {
  if (!SELF_ENDPOINT) {
    throw new Error("SELF_ENDPOINT must be configured");
  }

  const hexUserId = BigInt(discordUser.id).toString(16).padStart(40, "0");
  const userId = `0x${hexUserId.slice(0, 40)}`;

  // Build callback URL for mobile users
  // Use Discord deep link to return user directly to Discord app
  const callbackUrl = isMobile ? `discord://` : "";

  logEvent("verification.callback_url", "Building Self verification with callback", {
    sessionId,
    isMobile,
    callbackUrl: callbackUrl || "none (desktop)",
  });

  const selfApp = new SelfAppBuilder({
    version: 2,
    appName: SELF_APP_NAME,
    scope: "offchain", // Generic scope for offchain verification (not validated onchain)
    endpoint: SELF_ENDPOINT,
    logoBase64: SELF_LOGO_URL,
    userId,
    endpointType: "https",
    userIdType: "hex",
    userDefinedData: JSON.stringify({
      kind: "discord-self-verification",
      sessionId,
      discordUserId: discordUser.id,
      guildId: DISCORD_GUILD_ID,
    }),
    deeplinkCallback: callbackUrl, // Mobile users get redirected back after verification
    disclosures: {
      minimumAge: 18,
    },
  }).build();

  const universalLink = getUniversalLink(selfApp);

  let filename = null;
  let filePath = null;

  // Only generate QR code if requested (for desktop users)
  if (generateQr) {
    filename = `self-qr-${sessionId}.png`;
    filePath = path.join(qrOutputDir, filename);

    await QRCode.toFile(filePath, universalLink, {
      width: 512,
      errorCorrectionLevel: "H",
    });

    logEvent("qr.created", "Created Self QR code", {
      sessionId,
      userId: discordUser.id,
      filePath,
    });
  } else {
    logEvent("link.created", "Created Self deep link for mobile", {
      sessionId,
      userId: discordUser.id,
    });
  }

  return { universalLink, filename, filePath };
}

async function sendLogChannelMessage(message) {
  if (!DISCORD_LOG_CHANNEL_ID || !discordClient) return;
  try {
    const channel = await discordClient.channels.fetch(DISCORD_LOG_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      await channel.send(message);
    }
  } catch (err) {
    logEvent(
      "verification.log_channel_error",
      "Failed to send message to log channel",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
}

async function sendAlertsChannelMessage(message) {
  const targetChannelId = DISCORD_ALERTS_CHANNEL_ID || DISCORD_LOG_CHANNEL_ID;
  if (!targetChannelId || !discordClient) return;
  try {
    const channel = await discordClient.channels.fetch(targetChannelId);
    if (channel && channel.isTextBased()) {
      await channel.send(message);
    }
  } catch (err) {
    logEvent(
      "verification.alerts_channel_error",
      "Failed to send message to alerts channel",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
}

async function dmAdmin(message) {
  if (!DISCORD_ADMIN_USER_ID || !discordClient) return;
  try {
    const admin = await discordClient.users.fetch(DISCORD_ADMIN_USER_ID);
    const dm = await admin.createDM();
    await dm.send(message);
  } catch (err) {
    logEvent("discord.admin_dm_error", "Failed to DM the configured admin", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function buildVerificationEmbed({ success, discordUserId, reason }) {
  const embed = new EmbedBuilder()
    .setColor(success ? 0x3ecf8e : 0xf2545b)
    .setTitle(success ? "✅ Verification Succeeded" : "❌ Verification Failed")
    .setDescription(`<@${discordUserId}>`)
    .setTimestamp();

  if (!success && reason) {
    embed.addFields({ name: "Reason", value: reason });
  }

  return embed;
}

const VERIFY_REMINDER_DELAY_MS = 10 * 60 * 1000; // 10 minutes

function scheduleVerifyReminder(sessionId, discordUserId) {
  setTimeout(async () => {
    // Only remind if the session is still pending (not completed, failed, or flagged).
    if (!pendingVerifications.has(sessionId)) return;
    if (!discordClient) return;

    try {
      const user = await discordClient.users.fetch(discordUserId);
      const dm = await user.createDM();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("verify_help")
          .setLabel("❓ Help")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("verify_retry")
          .setLabel("🔄 Try Again")
          .setStyle(ButtonStyle.Success),
      );

      await dm.send({
        content:
          "👋 **Still there?**\n\n" +
          "You started verifying a little while ago but haven't finished yet. No rush, but here's a quick reminder in case you got stuck:\n\n" +
          "1️⃣ Open the **Self.xyz app** on your phone\n" +
          "2️⃣ Scan the QR code or tap the link we sent you\n" +
          "3️⃣ Scan your ID/passport inside the app\n" +
          "4️⃣ Wait for the checkmark - you'll get the Verified role automatically\n\n" +
          "Stuck on something? Tap **Help** below, or **Try Again** to get a fresh link.",
        components: [row],
      });

      logEvent("verification.reminder_sent", "Sent verification reminder DM", {
        sessionId,
        discordUserId,
      });
    } catch (err) {
      logEvent(
        "verification.reminder_error",
        "Failed to send verification reminder DM",
        {
          sessionId,
          discordUserId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }, VERIFY_REMINDER_DELAY_MS);
}

export async function handleDiscordVerificationSuccess(sessionId) {
  const entry = pendingVerifications.get(sessionId);
  if (!entry) {
    logEvent(
      "verification.unknown_session",
      "Verification for unknown session",
      {
        sessionId,
      },
    );
    return;
  }

  pendingVerifications.delete(sessionId);

  if (!discordClient) {
    logEvent(
      "verification.no_discord_client",
      "Discord client not ready when verification completed",
      { sessionId },
    );
    return;
  }

  const { discordUserId, guildId } = entry;

  try {
    const guild = await discordClient.guilds.fetch(guildId || DISCORD_GUILD_ID);
    const member = await guild.members.fetch(discordUserId);

    if (!DISCORD_VERIFIED_ROLE_ID) {
      logEvent(
        "verification.no_role_configured",
        "Verified role not configured",
        {
          guildId: guild.id,
          discordUserId,
        },
      );
    } else {
      const role =
        guild.roles.cache.get(DISCORD_VERIFIED_ROLE_ID) ||
        (await guild.roles.fetch(DISCORD_VERIFIED_ROLE_ID));

      if (!role) {
        logEvent(
          "verification.role_not_found",
          "Verified role id not found in guild",
          { guildId: guild.id, roleId: DISCORD_VERIFIED_ROLE_ID },
        );
      } else {
        await member.roles.add(role);
        logEvent("verification.role_assigned", "Assigned verified role", {
          guildId: guild.id,
          discordUserId,
          roleId: role.id,
        });
      }
    }

    try {
      const dm = await member.createDM();
      await dm.send(
        "🎉 **Verification Successful!**\n\n" +
        "✅ Your verification through Self.xyz has been completed successfully!\n\n" +
        "**What's New:**\n" +
        "• You've been granted the **Verified member** role\n" +
        "• You now have access to exclusive restricted channels\n" +
        "• Check out the newly unlocked channels in the Self Discord server\n\n" +
        "Welcome to the verified community! 🚀"
      );
    } catch (dmError) {
      logEvent(
        "verification.dm_failed",
        "Failed to DM user after verification",
        {
          discordUserId,
          error: dmError instanceof Error ? dmError.message : String(dmError),
        },
      );
    }

    await sendLogChannelMessage({
      embeds: [buildVerificationEmbed({ success: true, discordUserId })],
    });
  } catch (error) {
    logEvent(
      "verification.discord_error",
      "Failed to update Discord roles for verified user",
      {
        sessionId,
        discordUserId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export async function handleDuplicateIdentityDetected(
  sessionId,
  discordUserId,
  existingUserId,
) {
  const entry = pendingVerifications.get(sessionId);
  pendingVerifications.delete(sessionId);

  const guildId = entry?.guildId || DISCORD_GUILD_ID;

  const duplicateEmbed = new EmbedBuilder()
    .setColor(0xff6b6b)
    .setTitle("🚨 Duplicate ID Detected")
    .setDescription(
      `<@${discordUserId}> just tried to verify with an ID document that's already linked to <@${existingUserId}>.\n\n` +
        "No role was granted. This may be an alt account - worth a manual look.",
    )
    .setTimestamp();

  await sendAlertsChannelMessage({ embeds: [duplicateEmbed] });
  await dmAdmin(
    `🚨 Duplicate ID detected: <@${discordUserId}> tried to verify with an ID already linked to <@${existingUserId}>. Check ${
      DISCORD_ALERTS_CHANNEL_ID ? `<#${DISCORD_ALERTS_CHANNEL_ID}>` : "the alerts channel"
    } for details.`,
  );

  logEvent(
    "verification.duplicate_identity",
    "Same ID document already linked to a different Discord account",
    { discordUserId, existingUserId },
  );

  if (!discordClient) return;

  try {
    const guild = await discordClient.guilds.fetch(guildId);
    const member = await guild.members.fetch(discordUserId);
    const dm = await member.createDM();
    await dm.send(
      "⚠️ **Verification Didn't Complete**\n\n" +
        "Your ID document is already linked to a different Discord account on this server, so we couldn't grant you the Verified role automatically.\n\n" +
        "If this is a mistake (e.g. you lost access to an old account), please open a ticket and staff will help you sort it out.",
    );
  } catch (dmError) {
    logEvent(
      "verification.duplicate_dm_failed",
      "Failed to DM user after duplicate identity detection",
      {
        discordUserId,
        error: dmError instanceof Error ? dmError.message : String(dmError),
      },
    );
  }
}

const VERIFY_COOLDOWN_MS = 60 * 1000; // 60 seconds between attempts per user
const SESSION_EXPIRY_MINUTES = 30;
const lastVerifyAttempt = new Map();

async function handleVerifyCommand(interaction) {
  const user = interaction.user;

  const lastAttempt = lastVerifyAttempt.get(user.id);
  const now = Date.now();
  if (lastAttempt && now - lastAttempt < VERIFY_COOLDOWN_MS) {
    const waitSeconds = Math.ceil((VERIFY_COOLDOWN_MS - (now - lastAttempt)) / 1000);
    await interaction.reply({
      content: `Please wait ${waitSeconds}s before trying to verify again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  lastVerifyAttempt.set(user.id, now);

  let guild;
  try {
    guild = await discordClient.guilds.fetch(DISCORD_GUILD_ID);
  } catch (error) {
    logEvent(
      "discord.guild_fetch_error",
      "Failed to fetch guild while handling verify",
      { error: error instanceof Error ? error.message : String(error) },
    );
    await interaction.reply({
      content: "Something went wrong. Please try again in the server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = await guild.members.fetch(user.id);
  if (
    DISCORD_VERIFIED_ROLE_ID &&
    member.roles.cache.has(DISCORD_VERIFIED_ROLE_ID)
  ) {
    await interaction.reply({
      content:
        "You are already verified and should see the restricted channels.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Create platform selection buttons
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("verify_mobile")
      .setLabel("📱 I'm on Mobile")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("verify_desktop")
      .setLabel("🖥️ I'm on Desktop")
      .setStyle(ButtonStyle.Secondary)
  );

  try {
    await interaction.reply({
      content:
        "**Self.xyz Verification**\n\n" +
        "To verify your age and access restricted channels, please select your device type:",
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  } catch (replyError) {
    logEvent(
      "discord.interaction_reply_error",
      "Failed to send platform selection",
      {
        error:
          replyError instanceof Error ? replyError.message : String(replyError),
      },
    );
  }
}

async function handleUnverifyCommand(interaction) {
  const targetUser = interaction.options.getUser("user");

  if (!targetUser) {
    await interaction.reply({
      content: "Please pick a user.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const guild = await discordClient.guilds.fetch(DISCORD_GUILD_ID);
    const member = await guild.members.fetch(targetUser.id);

    let roleRemoved = false;
    if (DISCORD_VERIFIED_ROLE_ID && member.roles.cache.has(DISCORD_VERIFIED_ROLE_ID)) {
      await member.roles.remove(DISCORD_VERIFIED_ROLE_ID);
      roleRemoved = true;
    }

    const identitiesRemoved = removeIdentityByDiscordUserId(targetUser.id);

    await interaction.reply({
      content:
        `Done. ${roleRemoved ? "Removed the Verified role. " : "They didn't have the Verified role. "}` +
        `${identitiesRemoved > 0 ? `Cleared ${identitiesRemoved} linked ID record(s), so they can verify fresh.` : "No linked ID record found to clear."}`,
      flags: MessageFlags.Ephemeral,
    });

    logEvent("discord.unverify_command_used", "Staff manually unverified a user", {
      staffUserId: interaction.user.id,
      staffUsername: interaction.user.username,
      targetUserId: targetUser.id,
      roleRemoved,
      identitiesRemoved,
    });
  } catch (error) {
    logEvent("discord.unverify_command_error", "Failed to unverify user", {
      targetUserId: targetUser.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await interaction.reply({
      content: "Something went wrong while unverifying that user.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

function readRecentLogEntries(limit = 3000) {
  if (!fs.existsSync(LOG_FILE_PATH)) return [];
  const raw = fs.readFileSync(LOG_FILE_PATH, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const entries = [];
  for (const line of lines.slice(-limit)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

async function handleStatsCommand(interaction) {
  const entries = readRecentLogEntries(3000);

  const started = entries.filter((e) => e.type === "verification.started").length;
  const succeeded = entries.filter((e) => e.type === "verification.succeeded").length;
  const failed = entries.filter((e) => e.type === "verification.failed").length;
  const duplicates = entries.filter(
    (e) => e.type === "verification.duplicate_identity",
  ).length;
  const successRate =
    succeeded + failed > 0
      ? Math.round((succeeded / (succeeded + failed)) * 1000) / 10
      : null;
  const pendingNow = pendingVerifications.size;

  const lines = [
    `**Started:** ${started}`,
    `**Succeeded:** ${succeeded}`,
    `**Failed:** ${failed}`,
    `**Duplicate ID attempts:** ${duplicates}`,
    `**Success rate:** ${successRate === null ? "-" : successRate + "%"}`,
    `**Open sessions right now:** ${pendingNow}`,
    "",
    "_Based on recent logs, older history may have rolled off. Full dashboard has more detail._",
  ];

  await interaction.reply({
    content: `**Verification Stats**\n\n${lines.join("\n")}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleWhoisCommand(interaction) {
  const targetUser = interaction.options.getUser("user");

  if (!targetUser) {
    await interaction.reply({
      content: "Please pick a user.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let hasRole = false;
  try {
    const guild = await discordClient.guilds.fetch(DISCORD_GUILD_ID);
    const member = await guild.members.fetch(targetUser.id);
    hasRole = DISCORD_VERIFIED_ROLE_ID
      ? member.roles.cache.has(DISCORD_VERIFIED_ROLE_ID)
      : false;
  } catch {
    // member may have left the server, keep hasRole false
  }

  const entries = readRecentLogEntries(3000).filter(
    (e) => e.discordUserId === targetUser.id,
  );
  const reversed = [...entries].reverse();

  const lastSuccess = reversed.find((e) => e.type === "verification.role_assigned");
  const lastFailure = reversed.find((e) => e.type === "verification.failed");
  const lastDuplicate = reversed.find((e) => e.type === "verification.duplicate_identity");
  const hasPendingSession = [...pendingVerifications.values()].some(
    (v) => v.discordUserId === targetUser.id,
  );

  const lines = [
    `**Verified role:** ${hasRole ? "Yes" : "No"}`,
    `**Last successful verification:** ${
      lastSuccess ? new Date(lastSuccess.timestamp).toLocaleString() : "None found in recent logs"
    }`,
  ];

  if (lastFailure) {
    lines.push(`**Last failed attempt:** ${new Date(lastFailure.timestamp).toLocaleString()}`);
  }
  if (lastDuplicate) {
    lines.push(`**Flagged as duplicate ID:** ${new Date(lastDuplicate.timestamp).toLocaleString()}`);
  }

  lines.push(`**Pending session right now:** ${hasPendingSession ? "Yes" : "No"}`);
  lines.push("");
  lines.push("_Note: this only covers what's in recent logs, older history may have rolled off._");

  await interaction.reply({
    content: `**Verification info for <@${targetUser.id}>**\n\n${lines.join("\n")}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSetupVerifyButton(interaction) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("start_verify")
      .setLabel("✅ Verify")
      .setStyle(ButtonStyle.Success),
  );

  try {
    await interaction.channel.send({
      content:
        "Click Verify to gain access to the age restricted features of this server!",
      components: [row],
    });
    await interaction.reply({
      content: "Verify button posted in this channel.",
      flags: MessageFlags.Ephemeral,
    });
    logEvent(
      "discord.setup_verify_button_used",
      "Staff posted the verify button",
      {
        staffUserId: interaction.user.id,
        staffUsername: interaction.user.username,
        channelId: interaction.channel.id,
        channelName: interaction.channel.name,
      },
    );
  } catch (error) {
    logEvent(
      "discord.setup_verify_button_error",
      "Failed to post verify button",
      { error: error instanceof Error ? error.message : String(error) },
    );
    await interaction.reply({
      content:
        "Failed to post the verify button. Check that the bot can send messages in this channel.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleSayCommand(interaction) {
  const channel = interaction.options.getChannel("channel");
  const message = interaction.options.getString("message");

  if (!channel || !channel.isTextBased()) {
    await interaction.reply({
      content: "Please pick a text channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await channel.send(message);
    await interaction.reply({
      content: `Message sent in <#${channel.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
    logEvent("discord.say_command_used", "Staff used /say to send a message", {
      staffUserId: interaction.user.id,
      staffUsername: interaction.user.username,
      channelId: channel.id,
      channelName: channel.name,
      message,
    });
  } catch (error) {
    logEvent("discord.say_command_error", "Failed to send message via /say", {
      error: error instanceof Error ? error.message : String(error),
    });
    await interaction.reply({
      content:
        "Failed to send that message. Check that the bot can view and send messages in that channel.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleVerifyHelp(interaction) {
  await interaction.reply({
    content:
      "**Having trouble verifying?**\n\n" +
      "1️⃣ Make sure you have the **Self.xyz app** installed (App Store / Google Play)\n" +
      "2️⃣ Open the app, then scan the QR code or tap the link from your DM\n" +
      "3️⃣ Inside the app, scan your ID card or passport (needs a biometric chip - most IDs issued in the last ~15 years have one)\n" +
      "4️⃣ Wait for the green checkmark in the app - the Discord role is assigned automatically after that\n\n" +
      "If it's still not working, open a ticket and staff can verify you manually instead.",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleVerifyRetry(interaction) {
  await handleVerifyCommand(interaction);
}

async function handlePlatformSelection(interaction) {
  const user = interaction.user;
  const customId = interaction.customId;
  const isMobile = customId === "verify_mobile";

  const sessionId = crypto.randomUUID();

  try {
    await interaction.update({
      content:
        "Generating your Self verification link… I'll DM it to you shortly.",
      components: [],
    });
  } catch (updateError) {
    logEvent(
      "discord.interaction_update_error",
      "Failed to update interaction after platform selection",
      {
        error:
          updateError instanceof Error ? updateError.message : String(updateError),
      },
    );
    return;
  }

  let guild;
  try {
    guild = await discordClient.guilds.fetch(DISCORD_GUILD_ID);
  } catch (error) {
    logEvent(
      "discord.guild_fetch_error",
      "Failed to fetch guild while handling platform selection",
      { error: error instanceof Error ? error.message : String(error) },
    );
    try {
      await interaction.editReply({
        content: "Something went wrong. Please try again in the server.",
      });
    } catch {
      // best-effort only
    }
    return;
  }

  let verificationData;
  try {
    // Generate QR only for desktop users, pass isMobile flag for callback URL
    verificationData = await createSelfVerificationLink(sessionId, user, !isMobile, isMobile);
  } catch (error) {
    logEvent("verification.link_error", "Failed to create Self verification link", {
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      await interaction.editReply({
        content:
          "I couldn't create a verification link right now. Please try again later.",
      });
    } catch (editError) {
      logEvent(
        "discord.interaction_edit_error",
        "Failed to edit interaction reply after link error",
        {
          error:
            editError instanceof Error ? editError.message : String(editError),
        },
      );
    }
    return;
  }

  pendingVerifications.set(sessionId, {
    discordUserId: user.id,
    guildId: guild.id,
    createdAt: Date.now(),
    qrPath: verificationData.filePath,
  });

  scheduleVerifyReminder(sessionId, user.id);

  try {
    const dm = await user.createDM();

    if (isMobile) {
      // Create a short URL for better clickability on mobile
      const shortUrl = createShortUrl(verificationData.universalLink);

      // Mobile-only flow: Send instructions with short URL
      await dm.send(
          "📱 **Verification Required**\n\n" +
          "To access exclusive restricted channels in the Self Discord server, please complete verification using the Self.xyz mobile app.\n\n" +
          "**Tap the link below to verify:**\n\n" +
          shortUrl + "\n\n" +
          `⏳ This link expires in ${SESSION_EXPIRY_MINUTES} minutes.\n\n` +
          "Once verified, you'll automatically receive the **Verified member** role and gain access to exclusive channels!\n\n" +
          "━━━━━━━━━━━━━━━━━━━━━━"
      );
    } else {
      // Desktop flow: Send QR code
      const attachment = new AttachmentBuilder(verificationData.filePath, {
        name: verificationData.filename,
      });

      await dm.send({
        content:
          "🖥️ **Verification Required**\n\n" +
          "To access exclusive restricted channels in the Self Discord server, please complete verification using the Self.xyz mobile app.\n\n" +
          "**Scan the QR code below with the Self.xyz app on your phone:**\n\n" +
          "1️⃣ Open the Self.xyz app on your phone\n" +
          "2️⃣ Scan the QR code below\n" +
          "3️⃣ Complete the verification process\n\n" +
          `⏳ This QR code expires in ${SESSION_EXPIRY_MINUTES} minutes.\n\n` +
          "Once verified, you'll automatically receive the **Verified member** role and gain access to exclusive channels!\n\n" +
          "━━━━━━━━━━━━━━━━━━━━━━",
        files: [attachment],
      });

      // Discord has now hosted the image on its own CDN, so the local
      // copy is no longer needed.
      fs.unlink(verificationData.filePath, (unlinkErr) => {
        if (unlinkErr) {
          logEvent("qr.cleanup_error", "Failed to delete QR file after sending", {
            filePath: verificationData.filePath,
            error: unlinkErr.message,
          });
        }
      });
    }
  } catch (dmError) {
    logEvent("verification.dm_error", "Failed to DM user with verification link", {
      discordUserId: user.id,
      error: dmError instanceof Error ? dmError.message : String(dmError),
    });

    try {
      await interaction.editReply({
        content:
          "I couldn't send you a DM. Please enable DMs from this server and click Verify again.",
      });
    } catch (editError) {
      logEvent(
        "discord.interaction_edit_error",
        "Failed to edit interaction reply after DM error",
        {
          error:
            editError instanceof Error ? editError.message : String(editError),
        },
      );
    }

    return;
  }

  try {
    await interaction.editReply({
      content:
        "I've sent you a DM with your verification " + (isMobile ? "link" : "QR code") + ". Complete verification in the Self app and I'll automatically grant you access.",
    });
  } catch (editError) {
    logEvent(
      "discord.interaction_edit_error",
      "Failed to edit interaction reply after sending verification DM",
      {
        error:
          editError instanceof Error ? editError.message : String(editError),
      },
    );
  }

  logEvent("verification.started", "Started verification session", {
    sessionId,
    discordUserId: user.id,
    guildId: guild.id,
    platform: isMobile ? "mobile" : "desktop",
  });
}

async function registerDiscordCommands() {
  if (!DISCORD_BOT_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) {
    logEvent(
      "discord.config_missing",
      "Skipping slash command registration, env not fully configured",
      {
        hasToken: !!DISCORD_BOT_TOKEN,
        hasClientId: !!DISCORD_CLIENT_ID,
        hasGuildId: !!DISCORD_GUILD_ID,
      },
    );
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName("verify")
      .setDescription("Verify your age/identity using Self."),
    new SlashCommandBuilder()
      .setName("setup-verify-button")
      .setDescription("Post the Verify button in this channel (admin only).")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("say")
      .setDescription("Send a message through the bot (admin only).")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Channel to send the message in")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("message")
          .setDescription("The message content")
          .setRequired(true),
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("unverify")
      .setDescription("Remove a user's Verified role and clear their linked ID record (admin only).")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("The user to unverify")
          .setRequired(true),
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("whois")
      .setDescription("Look up a user's verification status (admin only).")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("The user to look up")
          .setRequired(true),
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("stats")
      .setDescription("Quick verification stats summary (admin only).")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  ].map((command) => command.toJSON());

  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);

  try {
    await rest.put(
      Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
      { body: commands },
    );
    logEvent("discord.commands_registered", "Registered slash commands", {
      guildId: DISCORD_GUILD_ID,
    });
  } catch (error) {
    logEvent("discord.commands_error", "Failed to register slash commands", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function startDiscordBot() {
  if (!DISCORD_BOT_TOKEN) {
    logEvent(
      "discord.config_missing",
      "DISCORD_BOT_TOKEN is not set, Discord bot will not start",
    );
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  async function updateBotPresence() {
    if (!DISCORD_VERIFIED_ROLE_ID) return;
    try {
      const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
      await guild.members.fetch(); // populate cache so the role count is accurate
      const role = await guild.roles.fetch(DISCORD_VERIFIED_ROLE_ID);
      const count = role ? role.members.size : 0;
      client.user.setActivity(`over ${count} verified members`, {
        type: ActivityType.Watching,
      });
    } catch (err) {
      logEvent("discord.presence_update_error", "Failed to update bot presence", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  client.once("clientReady", () => {
    logEvent("discord.ready", "Discord bot logged in", {
      username: client.user?.username,
      id: client.user?.id,
    });
    updateBotPresence();
    setInterval(updateBotPresence, 15 * 60 * 1000); // refresh every 15 minutes
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      // Handle slash commands
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "verify") {
          await handleVerifyCommand(interaction);
        }
        if (interaction.commandName === "setup-verify-button") {
          await handleSetupVerifyButton(interaction);
        }
        if (interaction.commandName === "say") {
          await handleSayCommand(interaction);
        }
        if (interaction.commandName === "unverify") {
          await handleUnverifyCommand(interaction);
        }
        if (interaction.commandName === "whois") {
          await handleWhoisCommand(interaction);
        }
        if (interaction.commandName === "stats") {
          await handleStatsCommand(interaction);
        }
      }

    // Handle button clicks
    if (interaction.isButton()) {
      if (interaction.customId === "start_verify") {
        await handleVerifyCommand(interaction);
      }
      if (interaction.customId === "verify_retry") {
        await handleVerifyRetry(interaction);
      }
      if (
        interaction.customId === "verify_mobile" ||
        interaction.customId === "verify_desktop"
      ) {
        await handlePlatformSelection(interaction);
      }
      if (interaction.customId === "verify_help") {
        await handleVerifyHelp(interaction);
      }
    }
  } catch (error) {
    logEvent("discord.interaction_error", "Error handling interaction", {
      type: interaction.type,
      customId: interaction.isButton()
        ? interaction.customId
        : interaction.commandName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

await registerDiscordCommands();

try {
  await client.login(DISCORD_BOT_TOKEN);
  discordClient = client;
} catch (error) {
  logEvent("discord.login_error", "Failed to login Discord bot", {
    error: error instanceof Error ? error.message : String(error),
  });
}
}

export async function handleDiscordVerificationFailure(sessionId, reason) {
  const entry = pendingVerifications.get(sessionId);
  if (!entry) {
    logEvent(
      "verification.unknown_session_failure",
      "Verification failure for unknown session",
      { sessionId },
    );
    return;
  }

  pendingVerifications.delete(sessionId);

  const { discordUserId, guildId } = entry;

  await sendLogChannelMessage({
    embeds: [buildVerificationEmbed({ success: false, discordUserId, reason })],
  });

  if (!discordClient) return;

  try {
    const guild = await discordClient.guilds.fetch(guildId || DISCORD_GUILD_ID);
    const member = await guild.members.fetch(discordUserId);
    const dm = await member.createDM();
    await dm.send(
      "❌ **Verification Failed**\n\n" +
      (reason ? `Reason: ${reason}\n\n` : "") +
      "Please click the Verify button in the server again to retry.",
    );
  } catch (dmError) {
    logEvent(
      "verification.failure_dm_failed",
      "Failed to DM user after failed verification",
      {
        discordUserId,
        error: dmError instanceof Error ? dmError.message : String(dmError),
      },
    );
  }
}
