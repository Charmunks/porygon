require("dotenv").config();
const { App } = require("@slack/bolt");
const cron = require("node-cron");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

const CHANNEL_ID = process.env.CHANNEL_ID;
const BOT_OWNER_ID = process.env.BOT_OWNER_ID;
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_USER = process.env.LASTFM_USER;
const FILESERVER_URL = process.env.FILESERVER_URL;
const FILESERVER_TOKEN = process.env.FILESERVER_TOKEN;

async function getTopTracksToday() {
  const now = Math.floor(Date.now() / 1000);
  const startOfDay = now - (now % 86400);
  
  const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${LASTFM_USER}&api_key=${LASTFM_API_KEY}&format=json&from=${startOfDay}&to=${now}&limit=200`;
  
  const response = await fetch(url);
  const data = await response.json();
  
  if (!data.recenttracks || !data.recenttracks.track) {
    return [];
  }
  
  const trackCounts = {};
  for (const track of data.recenttracks.track) {
    if (track["@attr"]?.nowplaying) continue;
    const key = `${track.name} - ${track.artist["#text"]}`;
    trackCounts[key] = (trackCounts[key] || 0) + 1;
  }
  
  return Object.entries(trackCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([track, count], i) => `${i + 1}. ${track} (${count} plays)`);
}

async function postTopTracks(channelId, isDaily = false) {
  const tracks = await getTopTracksToday();
  
  const prefix = isDaily ? "🌙 Hey Ivie! It's 7pm, you should probably give a daily update (if you want to.) Anyways, heres your top songs." : "🎵 Top 5 tracks today";
  
  if (tracks.length === 0) {
    return app.client.chat.postMessage({
      channel: channelId,
      text: `${prefix}\nNo tracks listened to today for ${LASTFM_USER}`
    });
  }
  
  const message = `${prefix}\nTop 5 tracks today for ${LASTFM_USER}:\n${tracks.join("\n")}`;
  
  return app.client.chat.postMessage({
    channel: channelId,
    text: message
  });
}

function isOwner(userId) {
  return userId === BOT_OWNER_ID;
}

app.command("/tracknow", async ({ command, ack, respond }) => {
  await ack();
  
  if (!isOwner(command.user_id)) {
    return respond({ text: "You don't have permission to use this command.", response_type: "ephemeral" });
  }
  
  await postTopTracks(command.channel_id);
  await respond({ text: "Posted top tracks!", response_type: "ephemeral" });
});

app.command("/echo", async ({ command, ack, respond, client }) => {
  await ack();
  
  if (!isOwner(command.user_id)) {
    return respond({ text: "You don't have permission to use this command.", response_type: "ephemeral" });
  }
  
  const userInfo = await client.users.info({ user: command.user_id });
  const profile = userInfo.user.profile;
  
  const text = command.text;
  
  await client.chat.postMessage({
    channel: command.channel_id,
    text: text,
    username: profile.display_name || profile.real_name || userInfo.user.name,
    icon_url: profile.image_512 || profile.image_192,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: text
        }
      }
    ]
  });
});

app.event("app_mention", async ({ event, client }) => {
  console.log("[upload] app_mention event received", { user: event.user, hasFiles: !!event.files });
  
  if (!isOwner(event.user)) {
    console.log("[upload] user is not owner, ignoring");
    return;
  }

  const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  console.log("[upload] parsed text:", text, "files:", event.files?.length || 0);
  
  if (!text || !event.files || event.files.length === 0) {
    console.log("[upload] no text or files, ignoring");
    return;
  }

  const lastSlash = text.lastIndexOf("/");
  let folder = null;
  let filename = text;

  if (lastSlash !== -1) {
    folder = text.substring(0, lastSlash);
    filename = text.substring(lastSlash + 1);
  }
  console.log("[upload] folder:", folder, "filename:", filename);

  const file = event.files[0];
  console.log("[upload] file info:", { name: file.name, mimetype: file.mimetype, url: file.url_private });

  try {
    console.log("[upload] fetching file from Slack...");
    const fileResponse = await fetch(file.url_private, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
    });
    
    if (!fileResponse.ok) {
      console.log("[upload] failed to fetch from Slack:", fileResponse.status, fileResponse.statusText);
      throw new Error(`Failed to fetch file from Slack: ${fileResponse.status}`);
    }
    
    const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
    console.log("[upload] fetched file, size:", fileBuffer.length);

    const formData = new FormData();
    formData.append("files", new Blob([fileBuffer], { type: file.mimetype }), filename);
    if (folder) formData.append("folder", folder);
    formData.append("isPublic", "true");

    console.log("[upload] uploading to:", `${FILESERVER_URL}/api/upload`);
    const uploadResponse = await fetch(`${FILESERVER_URL}/api/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${FILESERVER_TOKEN}` },
      body: formData
    });

    const responseText = await uploadResponse.text();
    console.log("[upload] server response:", uploadResponse.status, responseText);
    
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      throw new Error(`Invalid JSON response: ${responseText}`);
    }

    if (result.success) {
      await client.chat.postMessage({
        channel: event.channel,
        text: `Uploaded: ${FILESERVER_URL}/files/${result.files[0].id}`,
        thread_ts: event.ts
      });
    } else {
      await client.chat.postMessage({
        channel: event.channel,
        text: `Upload failed: ${result.error || "Unknown error"}`,
        thread_ts: event.ts
      });
    }
  } catch (error) {
    console.error("[upload] error:", error);
    await client.chat.postMessage({
      channel: event.channel,
      text: `Upload error: ${error.message}`,
      thread_ts: event.ts
    });
  }
});

cron.schedule("0 19 * * *", async () => {
  console.log("Running daily top tracks post...");
  await postTopTracks(CHANNEL_ID, true);
}, {
  timezone: "America/New_York"
});

(async () => {
  await app.start();
  console.log("⚡ Charbot is running!");
})();
