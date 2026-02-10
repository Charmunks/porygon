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
const SLACK_USER_TOKEN = process.env.SLACK_USER_TOKEN;

const allowedUploadUsers = new Set([BOT_OWNER_ID]);

function isAllowedUploader(userId) {
  return allowedUploadUsers.has(userId);
}

async function getNowPlaying() {
  const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${LASTFM_USER}&api_key=${LASTFM_API_KEY}&format=json&limit=1`;
  const response = await fetch(url);
  const data = await response.json();

  if (!data.recenttracks || !data.recenttracks.track || data.recenttracks.track.length === 0) {
    return null;
  }

  const track = data.recenttracks.track[0];
  const isPlaying = !!track["@attr"]?.nowplaying;
  return {
    name: track.name,
    artist: track.artist["#text"],
    album: track.album?.["#text"] || null,
    image: track.image?.find(i => i.size === "extralarge")?.["#text"] || track.image?.find(i => i.size === "large")?.["#text"] || null,
    url: track.url || null,
    isPlaying
  };
}

async function getTopTracksToday() {
  const now = new Date();
  const estOffset = -5 * 60;
  const estNow = new Date(now.getTime() + (now.getTimezoneOffset() + estOffset) * 60000);
  estNow.setHours(0, 0, 0, 0);
  const startOfDay = Math.floor(estNow.getTime() / 1000) - (now.getTimezoneOffset() + estOffset) * 60;
  const nowUnix = Math.floor(Date.now() / 1000);
  
  const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${LASTFM_USER}&api_key=${LASTFM_API_KEY}&format=json&from=${startOfDay}&to=${nowUnix}&limit=200`;
  
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

async function getTopArtistsToday() {
  const now = new Date();
  const estOffset = -5 * 60;
  const estNow = new Date(now.getTime() + (now.getTimezoneOffset() + estOffset) * 60000);
  estNow.setHours(0, 0, 0, 0);
  const startOfDay = Math.floor(estNow.getTime() / 1000) - (now.getTimezoneOffset() + estOffset) * 60;
  const nowUnix = Math.floor(Date.now() / 1000);
  
  const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${LASTFM_USER}&api_key=${LASTFM_API_KEY}&format=json&from=${startOfDay}&to=${nowUnix}&limit=200`;
  
  const response = await fetch(url);
  const data = await response.json();
  
  if (!data.recenttracks || !data.recenttracks.track) {
    return [];
  }
  
  const artistCounts = {};
  for (const track of data.recenttracks.track) {
    if (track["@attr"]?.nowplaying) continue;
    const artist = track.artist["#text"];
    artistCounts[artist] = (artistCounts[artist] || 0) + 1;
  }
  
  return Object.entries(artistCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([artist, count], i) => `${i + 1}. ${artist} (${count} plays)`);
}

async function postTopTracks(channelId, isDaily = false, threadTs = null) {
  const [tracks, artists] = await Promise.all([getTopTracksToday(), getTopArtistsToday()]);
  
  const prefix = isDaily ? "🌙 Hey Ivie! It's 7pm, you should probably give a daily update (if you want to.) Anyways, heres your top songs." : "🎵 Top 5 tracks today";
  
  if (tracks.length === 0 && artists.length === 0) {
    return app.client.chat.postMessage({
      channel: channelId,
      text: `${prefix}\nNo tracks listened to today for ${LASTFM_USER}`,
      ...(threadTs && { thread_ts: threadTs })
    });
  }
  
  let message = `${prefix}\n`;
  if (tracks.length > 0) {
    message += `*Top 5 tracks today for ${LASTFM_USER}:*\n${tracks.join("\n")}`;
  }
  if (artists.length > 0) {
    message += `\n\n*Top 5 artists today:*\n${artists.join("\n")}`;
  }
  
  return app.client.chat.postMessage({
    channel: channelId,
    text: message,
    ...(threadTs && { thread_ts: threadTs })
  });
}

function isOwner(userId) {
  return userId === BOT_OWNER_ID;
}

app.command("/lyrics", async ({ command, ack, respond }) => {
  await ack();

  const args = command.text?.trim();
  if (!args) {
    return respond({ text: "Usage: `/lyrics <song name> | <line count>`", response_type: "ephemeral" });
  }

  const parts = args.split("|").map(s => s.trim());
  const songQuery = parts[0];
  const lineCount = parseInt(parts[1], 10) || 10;

  if (!songQuery) {
    return respond({ text: "Please provide a song name. Usage: `/lyrics <song name> | <line count>`", response_type: "ephemeral" });
  }

  try {
    const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(songQuery)}`;
    const searchResponse = await fetch(searchUrl, {
      headers: { "User-Agent": "Charbot/1.0 (https://github.com/Charmunks/porygon)" }
    });
    const results = await searchResponse.json();

    if (!Array.isArray(results) || results.length === 0) {
      return respond({ text: `No lyrics found for "${songQuery}".`, response_type: "ephemeral" });
    }

    const track = results.find(r => r.plainLyrics) || results[0];
    if (!track.plainLyrics) {
      return respond({ text: `No lyrics available for "${track.trackName}" by ${track.artistName} (might be instrumental).`, response_type: "ephemeral" });
    }

    const rawLines = track.plainLyrics.split("\n");
    const allLines = [];
    let contentLineCount = 0;
    for (const line of rawLines) {
      if (line.trim()) {
        contentLineCount++;
        allLines.push(line);
        if (contentLineCount >= lineCount) break;
      } else if (allLines.length > 0) {
        allLines.push("");
      }
    }
    while (allLines.length > 0 && !allLines[allLines.length - 1].trim()) {
      allLines.pop();
    }
    const totalContentLines = rawLines.filter(l => l.trim()).length;
    const truncated = totalContentLines > lineCount;

    let message = `*${track.trackName}* by *${track.artistName}*`;
    if (track.albumName) message += ` (_${track.albumName}_)`;
    message += `\n\n${allLines.join("\n")}`;
    if (truncated) message += `\n\n_...showing ${lineCount} of ${totalContentLines} lines_`;

    await app.client.chat.postMessage({
      channel: command.channel_id,
      text: message
    });
  } catch (error) {
    console.error("[lyrics] error:", error);
    await respond({ text: `Error fetching lyrics: ${error.message}`, response_type: "ephemeral" });
  }
});

app.command("/tracknow", async ({ command, ack, respond, body }) => {
  await ack();
  
  if (!isOwner(command.user_id)) {
    return respond({ text: "You don't have permission to use this command.", response_type: "ephemeral" });
  }
  
  const threadTs = command.text?.trim() || null;
  await postTopTracks(command.channel_id, false, threadTs);
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

app.command("/add-allow", async ({ command, ack, respond }) => {
  await ack();
  
  if (!isOwner(command.user_id)) {
    return respond({ text: "Only the bot owner can add users to the allow list.", response_type: "ephemeral" });
  }
  
  const match = command.text.match(/<@([A-Z0-9]+)\|?[^>]*>/);
  if (!match) {
    return respond({ text: "Please mention a user to add. Usage: /add-allow @user", response_type: "ephemeral" });
  }
  
  const userId = match[1];
  if (allowedUploadUsers.has(userId)) {
    return respond({ text: `<@${userId}> is already on the allow list.`, response_type: "ephemeral" });
  }
  
  allowedUploadUsers.add(userId);
  await respond({ text: `Added <@${userId}> to the upload allow list.`, response_type: "ephemeral" });
});

app.command("/list-allow", async ({ command, ack, respond }) => {
  await ack();
  
  const users = Array.from(allowedUploadUsers).map(id => `<@${id}>`).join("\n");
  await respond({ text: `*Allowed uploaders:*\n${users}`, response_type: "ephemeral" });
});

app.event("app_mention", async ({ event, client }) => {
  console.log("[upload] app_mention event received", { user: event.user, hasFiles: !!event.files });
  
  if (!isAllowedUploader(event.user)) {
    console.log("[upload] user is not allowed, ignoring");
    await client.chat.postMessage({
      channel: event.channel,
      text: "Unauthorized :loll: Dm Ivie if this is a mistake",
      thread_ts: event.ts
    });
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

const POKEAPI_BASE = "https://pokeapi.co/api/v2";

async function lookupPokemonInfo(query) {
  const name = query.toLowerCase().replace(/\s+/g, "-");

  const endpoints = [
    { type: "pokemon", url: `${POKEAPI_BASE}/pokemon/${name}` },
    { type: "move", url: `${POKEAPI_BASE}/move/${name}` },
    { type: "ability", url: `${POKEAPI_BASE}/ability/${name}` },
    { type: "item", url: `${POKEAPI_BASE}/item/${name}` },
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint.url);
      if (!res.ok) continue;
      const data = await res.json();
      return { type: endpoint.type, data };
    } catch {
      continue;
    }
  }
  return null;
}

function formatPokemonInfo(data) {
  const types = data.types.map(t => t.type.name).join(", ");
  const abilities = data.abilities.map(a => `${a.ability.name}${a.is_hidden ? " _(hidden)_" : ""}`).join(", ");
  const stats = data.stats.map(s => `${s.stat.name}: *${s.base_stat}*`).join(" | ");
  const sprite = data.sprites?.other?.["official-artwork"]?.front_default || data.sprites?.front_default || null;

  const blocks = [];
  const section = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        `*#${data.id}: ${data.name.replace(/-/g, " ")}*`,
        `*Type:* ${types}`,
        `*Abilities:* ${abilities}`,
        `*Height:* ${(data.height / 10).toFixed(1)}m | *Weight:* ${(data.weight / 10).toFixed(1)}kg`,
        `*Stats:* ${stats}`,
      ].join("\n"),
    },
  };
  if (sprite) {
    section.accessory = { type: "image", image_url: sprite, alt_text: data.name };
  }
  blocks.push(section);
  return { text: `Info: ${data.name}`, blocks };
}

function formatMoveInfo(data) {
  const effect = data.effect_entries?.find(e => e.language.name === "en")?.short_effect || "No description available.";
  const flavorText = data.flavor_text_entries?.find(e => e.language.name === "en")?.flavor_text || null;

  return {
    text: `Move: ${data.name}`,
    blocks: [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Move: ${data.name.replace(/-/g, " ")}*`,
          `*Type:* ${data.type?.name || "-"} | *Class:* ${data.damage_class?.name || "-"}`,
          `*Power:* ${data.power ?? "-"} | *Accuracy:* ${data.accuracy ?? "—"} | *PP:* ${data.pp ?? "-"}`,
          `*Effect:* ${effect}`,
          flavorText ? `${flavorText}` : null,
        ].filter(Boolean).join("\n"),
      },
    }],
  };
}

function formatAbilityInfo(data) {
  const effect = data.effect_entries?.find(e => e.language.name === "en")?.short_effect || "No description available.";
  const flavorText = data.flavor_text_entries?.find(e => e.language.name === "en")?.flavor_text || null;
  const pokemonList = data.pokemon?.slice(0, 8).map(p => p.pokemon.name.replace(/-/g, " ")).join(", ") || "—";

  return {
    text: `Ability: ${data.name}`,
    blocks: [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Ability: ${data.name.replace(/-/g, " ")}*`,
          `*Generation:* ${data.generation?.name || "—"}`,
          `*Effect:* ${effect}`,
          flavorText ? `_${flavorText}_` : null,
          `*Pokemon:* ${pokemonList}${data.pokemon?.length > 8 ? ` (+${data.pokemon.length - 8} more)` : ""}`,
        ].filter(Boolean).join("\n"),
      },
    }],
  };
}

function formatItemInfo(data) {
  const effect = data.effect_entries?.find(e => e.language.name === "en")?.short_effect || "No description available.";
  const flavorText = data.flavor_text_entries?.find(e => e.language.name === "en")?.text || null;
  const sprite = data.sprites?.default || null;

  const blocks = [];
  const section = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        `*Item: ${data.name.replace(/-/g, " ")}*`,
        `*Category:* ${data.category?.name?.replace(/-/g, " ") || "—"}`,
        data.cost ? `*Cost:* ${data.cost}₽` : null,
        `*Effect:* ${effect}`,
        flavorText ? `_${flavorText}_` : null,
      ].filter(Boolean).join("\n"),
    },
  };
  if (sprite) {
    section.accessory = { type: "image", image_url: sprite, alt_text: data.name };
  }
  blocks.push(section);
  return { text: `Item: ${data.name}`, blocks };
}

app.message(async ({ message, client }) => {
  if (message.subtype) return;
  const text = message.text?.trim() || "";
  const lower = text.toLowerCase();

  if (lower === ".fm") {
    if (message.user !== BOT_OWNER_ID) return;
    console.log("[fm] .fm triggered");

    try {
      const track = await getNowPlaying();

      if (!track) {
        return;
      }

      const emoji = track.isPlaying ? ":musical_note:" : ":headphones:";
      const status = track.isPlaying ? "Now playing" : "Last played";
      const fallback = `${status}: ${track.name} by ${track.artist}`;

      const blocks = [];

      const sectionBlock = {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *${status}*\n\n*${track.url ? `<${track.url}|${track.name}>` : track.name}*\nby *${track.artist}*${track.album ? `\non _${track.album}_` : ""}`
        }
      };

      if (track.image) {
        sectionBlock.accessory = {
          type: "image",
          image_url: track.image,
          alt_text: track.album || track.name
        };
      }

      blocks.push(sectionBlock);

      await client.chat.postMessage({
        token: SLACK_USER_TOKEN,
        channel: message.channel,
        text: fallback,
        blocks
      });
    } catch (error) {
      console.error("[fm] error:", error);
    }
  } else {
    if (!lower.startsWith(".info ")) return;
    const query = text.slice(6).trim();
    console.log(`[debug] query: "${query}"`);
    if (!query) return;

    console.log(`[info] .info triggered with query: ${query}`);

    try {
      const result = await lookupPokemonInfo(query);

      if (!result) {
        await client.chat.postMessage({
          token: SLACK_USER_TOKEN,
          channel: message.channel,
          text: `Nothing found for "${query}". Try a Pokémon, move, ability, or item name.`,
        });
        return;
      }

      let formatted;
      switch (result.type) {
        case "pokemon": formatted = formatPokemonInfo(result.data); break;
        case "move": formatted = formatMoveInfo(result.data); break;
        case "ability": formatted = formatAbilityInfo(result.data); break;
        case "item": formatted = formatItemInfo(result.data); break;
      }

      await client.chat.postMessage({
        token: SLACK_USER_TOKEN,
        channel: message.channel,
        text: formatted.text,
        blocks: formatted.blocks,
      });
    } catch (error) {
      console.error("[info] error:", error);
    }
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
