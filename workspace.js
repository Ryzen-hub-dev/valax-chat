const params = new URLSearchParams(window.location.search);
const guildId = params.get("guildId") || "";
const requestedChannelId = params.get("channelId") || "";
const requestedBotId = params.get("botId") || "";

const statusView = document.querySelector("[data-chat-status]");
const errorView = document.querySelector("[data-workspace-error]");
const errorMessage = document.querySelector("[data-workspace-error-message]");
const workspaceView = document.querySelector("[data-chat-workspace]");
const channelList = document.querySelector("[data-channel-list]");
const messageStream = document.querySelector("[data-message-stream]");
const messageLoading = document.querySelector("[data-message-loading]");
const messageEmpty = document.querySelector("[data-message-empty]");
const messageList = document.querySelector("[data-message-list]");
const messageInput = document.querySelector("[data-message-input]");
const messageForm = document.querySelector("[data-message-form]");
const sendButton = document.querySelector("[data-send-message]");
const characterCount = document.querySelector("[data-character-count]");
const composerStatus = document.querySelector("[data-composer-status]");
const modeBanner = document.querySelector("[data-composer-mode-banner]");
const modeBannerText = document.querySelector("[data-composer-mode-text]");
const refreshButton = document.querySelector("[data-refresh-messages]");
const toast = document.querySelector("[data-workspace-toast]");
const toastMessage = document.querySelector("[data-workspace-toast-message]");
const toastIcon = document.querySelector("[data-workspace-toast-icon]");
const memberDialog = document.querySelector("[data-member-dialog]");
const memberList = document.querySelector("[data-member-list]");
const memberSearch = document.querySelector("[data-member-search]");
const dmDialog = document.querySelector("[data-dm-dialog]");
const dmMessageList = document.querySelector("[data-dm-message-list]");
const dmInput = document.querySelector("[data-dm-input]");
const campaignDialog = document.querySelector("[data-campaign-dialog]");
const notificationDialog = document.querySelector("[data-notification-dialog]");
const expressionDialog = document.querySelector("[data-expression-dialog]");
const expressionGrid = document.querySelector("[data-expression-grid]");
const expressionSearch = document.querySelector("[data-expression-search]");
const workspaceBotSelector = document.querySelector("[data-workspace-bot-selector]");
const mentionSuggestions = document.querySelector("[data-mention-suggestions]");
const messageFileInput = document.querySelector("[data-message-file]");
const dmFileInput = document.querySelector("[data-dm-file]");
const messageAttachmentPreview = document.querySelector("[data-message-attachment-preview]");
const dmAttachmentPreview = document.querySelector("[data-dm-attachment-preview]");
const selectedStickersView = document.querySelector("[data-selected-stickers]");

let workspace = null;
let selectedChannel = null;
let messageMode = "message";
let messagesLoading = false;
let sendInProgress = false;
let toastTimer = null;
let replyTarget = null;
let selectedMentionIds = new Set();
let memberAfter = null;
let memberSearchTimer = null;
let activeDmMember = null;
let dmLoading = false;
let dmRequestSequence = 0;
let activeDmLastId = null;
let activeCampaign = null;
let campaignTimer = null;
let notificationSettings = {
  enabled: true,
  browser: true,
  sounds: true,
  normalMessages: false,
  mentions: true,
  replies: true,
  directMessages: true,
  groupWindowSeconds: 8,
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
};
const lastMessageIdByChannel = new Map();
const lastAlertAt = new Map();
let lastBackgroundSyncAt = 0;
let mentionAutocompleteTimer = null;
let mentionAutocompleteController = null;
let mentionAutocompleteTrigger = null;
let mentionAutocompleteMembers = [];
let mentionAutocompleteIndex = 0;
let messageAttachment = null;
let dmAttachment = null;
let expressions = null;
let expressionsLoading = false;
let expressionTarget = "message";
let expressionTab = "emoji";
let selectedStickers = [];
const expressionSaveInProgress = new Set();
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

function apiQuery(values = {}) {
  return new URLSearchParams({ guildId, botId: workspace?.bot?.id || requestedBotId, ...values });
}

function refreshIcons() {
  window.lucide?.createIcons();
}

function icon(name) {
  const element = document.createElement("i");
  element.dataset.lucide = name;
  element.setAttribute("aria-hidden", "true");
  return element;
}

function replaceAvatar(container, imageUrl, label, fallbackIcon = "bot") {
  if (!container) return;
  if (imageUrl) {
    const image = document.createElement("img");
    image.src = imageUrl;
    image.alt = label;
    image.width = 64;
    image.height = 64;
    container.replaceChildren(image);
  } else {
    container.replaceChildren(icon(fallbackIcon));
  }
}

function leaveFor(destination) {
  document.body.classList.remove("page-enter", "page-ready");
  document.body.classList.add("is-leaving");
  window.setTimeout(() => window.location.replace(destination), 460);
}

async function readPayload(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function routeForApiError(response, payload) {
  if (response.status === 401 && payload.code === "AUTH_REQUIRED") {
    leaveFor("/login?returnTo=%2Fdashboard");
    return true;
  }
  if (["BOT_TOKEN_INVALID", "BOT_TOKEN_RECONNECT_REQUIRED", "BOT_SETUP_REQUIRED"].includes(payload.code)) {
    leaveFor("/setup");
    return true;
  }
  if (["SERVER_TEST_REQUIRED", "GUILD_NOT_FOUND", "SETUP_REQUIRED"].includes(payload.code)) {
    leaveFor("/dashboard");
    return true;
  }
  return false;
}

function showError(message) {
  statusView.hidden = true;
  workspaceView.hidden = true;
  errorMessage.textContent = message;
  errorView.hidden = false;
}

function showToast(message, isError = false) {
  window.clearTimeout(toastTimer);
  toastMessage.textContent = message;
  toast.classList.toggle("is-error", isError);
  toastIcon.dataset.lucide = isError ? "circle-alert" : "circle-check";
  toast.hidden = false;
  refreshIcons();
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

function createRailServer(server) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `rail-server${server.id === workspace.server.id ? " is-active" : ""}`;
  button.title = server.name;
  button.setAttribute("aria-label", `Open ${server.name}`);
  if (server.iconUrl) {
    const image = document.createElement("img");
    image.src = server.iconUrl;
    image.alt = "";
    image.width = 46;
    image.height = 46;
    button.append(image);
  } else {
    const label = document.createElement("span");
    label.textContent = server.name.slice(0, 1).toUpperCase();
    button.append(label);
  }
  button.addEventListener("click", () => {
    if (server.id !== workspace.server.id) {
      leaveFor(`/server?guildId=${encodeURIComponent(server.id)}&botId=${encodeURIComponent(workspace.bot.id)}`);
    }
  });
  return button;
}

function createChannelButton(channel) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `channel-button${selectedChannel?.id === channel.id ? " is-active" : ""}`;
  button.dataset.channelId = channel.id;
  button.append(icon(channel.announcement ? "megaphone" : "hash"));
  const name = document.createElement("span");
  name.textContent = channel.name;
  button.append(name);
  if (channel.nsfw) {
    const label = document.createElement("small");
    label.textContent = "NSFW";
    button.append(label);
  }
  button.addEventListener("click", () => selectChannel(channel));
  return button;
}

function createChannelGroup(name, channels) {
  const group = document.createElement("section");
  group.className = "channel-group";
  const heading = document.createElement("p");
  heading.className = "channel-group-title";
  heading.append(icon("chevron-down"), name);
  group.append(heading, ...channels.map(createChannelButton));
  return group;
}

function renderChannels() {
  if (!workspace.channels.length) {
    const empty = document.createElement("div");
    empty.className = "channel-list-empty";
    empty.append(icon("message-square-off"));
    const text = document.createElement("span");
    text.textContent = "No text channels are available to this bot.";
    empty.append(text);
    channelList.replaceChildren(empty);
    refreshIcons();
    return;
  }

  const groups = [];
  const uncategorized = workspace.channels.filter((channel) => !channel.parentId);
  if (uncategorized.length) groups.push(createChannelGroup("Channels", uncategorized));
  workspace.categories.forEach((category) => {
    const channels = workspace.channels.filter((channel) => channel.parentId === category.id);
    if (channels.length) groups.push(createChannelGroup(category.name, channels));
  });
  channelList.replaceChildren(...groups);
  refreshIcons();
}

function renderWorkspace(payload) {
  workspace = payload;
  statusView.hidden = true;
  errorView.hidden = true;
  workspaceView.hidden = false;

  document.querySelector("[data-server-name]").textContent = payload.server.name;
  document.querySelector("[data-bot-name]").textContent = payload.bot.username;
  replaceAvatar(document.querySelector("[data-server-avatar]"), payload.server.iconUrl, `${payload.server.name} icon`, "server");
  replaceAvatar(document.querySelector("[data-bot-avatar]"), payload.bot.avatarUrl, `${payload.bot.username} avatar`);
  document.querySelector("[data-rail-servers]").replaceChildren(...payload.servers.map(createRailServer));
  if (workspaceBotSelector && payload.bots?.length > 1) {
    workspaceBotSelector.replaceChildren(...payload.bots.map((bot) => {
      const option = document.createElement("option");
      option.value = bot.id;
      option.textContent = bot.username;
      option.selected = bot.id === payload.bot.id;
      return option;
    }));
    workspaceBotSelector.hidden = false;
    document.querySelector("[data-bot-name]").hidden = true;
  }

  selectedChannel = payload.channels.find((channel) => channel.id === requestedChannelId) || payload.channels[0] || null;
  renderChannels();
  if (selectedChannel) {
    updateSelectedChannel();
    loadMessages();
  } else {
    messageLoading.hidden = true;
    messageEmpty.hidden = false;
    messageInput.disabled = true;
    sendButton.disabled = true;
  }
  loadNotificationSettings();
  resumeActiveCampaign();
  refreshIcons();
}

async function loadWorkspace() {
  if (!/^\d{17,20}$/.test(guildId)) {
    leaveFor("/dashboard");
    return;
  }
  statusView.hidden = false;
  errorView.hidden = true;

  try {
    const response = await fetch(`/api/server?${apiQuery()}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const payload = await readPayload(response);
    if (routeForApiError(response, payload)) return;
    if (!response.ok) throw new Error(payload.error || "Valax could not load this server.");
    renderWorkspace(payload);
  } catch (error) {
    showError(error instanceof Error ? error.message : "Valax could not load this server.");
  }
}

function updateSelectedChannel() {
  document.querySelector("[data-channel-name]").textContent = selectedChannel.name;
  document.querySelector("[data-channel-topic]").textContent = selectedChannel.topic || "Discord text channel";
  document.querySelector("[data-channel-icon]").dataset.lucide = selectedChannel.announcement ? "megaphone" : "hash";
  document.querySelectorAll("[data-channel-id]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.channelId === selectedChannel.id);
  });
  const url = new URL(window.location.href);
  url.searchParams.set("channelId", selectedChannel.id);
  window.history.replaceState({}, "", url);
  messageInput.disabled = false;
  updateComposer();
  updateModeBanner();
  refreshIcons();
}

function selectChannel(channel) {
  if (selectedChannel?.id === channel.id) {
    setWorkspaceMenu(false);
    return;
  }
  selectedChannel = channel;
  updateSelectedChannel();
  setWorkspaceMenu(false);
  loadMessages();
}

function resolveMessageContent(message) {
  return (message.mentions || []).reduce(
    (content, mention) => content.replaceAll(`<@${mention.id}>`, `@${mention.displayName}`),
    message.content
  );
}

function safeMediaUrl(value) {
  try {
    const parsed = new URL(value);
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function appendDiscordContent(container, message, allowSaveExpressions = true) {
  const source = message.content || "";
  const mentions = new Map((message.mentions || []).map((mention) => [mention.id, mention.displayName]));
  const pattern = /<(a?):([a-zA-Z0-9_]{1,32}):(\d{17,20})>|<@!?(\d{17,20})>/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) container.append(document.createTextNode(source.slice(cursor, match.index)));
    if (match[3]) {
      const image = document.createElement("img");
      image.className = "message-custom-emoji";
      image.src = `https://cdn.discordapp.com/emojis/${match[3]}.${match[1] ? "gif" : "png"}?size=64&quality=lossless`;
      image.alt = `:${match[2]}:`;
      image.title = `:${match[2]}:`;
      image.loading = "lazy";
      if (allowSaveExpressions) {
        const save = document.createElement("button");
        save.type = "button";
        save.className = "message-expression-save";
        save.title = `Save :${match[2]}: to Saved Expressions`;
        save.setAttribute("aria-label", `Save ${match[2]} to Saved Expressions`);
        save.append(image);
        save.addEventListener("click", () => saveObservedExpression({
          id: match[3],
          type: "emoji",
          name: match[2],
        }, message));
        container.append(save);
      } else {
        container.append(image);
      }
    } else {
      const mention = document.createElement("span");
      mention.className = "message-mention";
      mention.textContent = `@${mentions.get(match[4]) || "member"}`;
      container.append(mention);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) container.append(document.createTextNode(source.slice(cursor)));
}

function createAttachment(attachment) {
  const attachmentUrl = safeMediaUrl(attachment.url);
  if (!attachmentUrl) return document.createTextNode(attachment.filename);
  const type = attachment.contentType || "";
  const imageLike = type.startsWith("image/") || /\.(?:avif|gif|jpe?g|png|webp)$/i.test(attachment.filename || "");
  const videoLike = type.startsWith("video/") || /\.(?:mov|mp4|webm)$/i.test(attachment.filename || "");

  if (imageLike) {
    const link = document.createElement("a");
    link.className = "message-attachment-image";
    link.href = attachmentUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    const image = document.createElement("img");
    image.src = attachmentUrl;
    image.alt = attachment.filename;
    image.loading = "lazy";
    link.append(image);
    return link;
  }
  if (videoLike) {
    const video = document.createElement("video");
    video.className = "message-attachment-video";
    video.src = attachmentUrl;
    video.controls = true;
    video.preload = "metadata";
    video.setAttribute("playsinline", "");
    return video;
  }
  const link = document.createElement("a");
  link.className = "message-attachment-file";
  link.href = attachmentUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.append(icon("paperclip"), attachment.filename);
  return link;
}

function createSticker(sticker, message, allowSaveExpressions = true) {
  const url = safeMediaUrl(sticker.url);
  if (!url) return document.createTextNode(sticker.name || "Discord sticker");
  const image = document.createElement("img");
  image.className = "message-sticker";
  image.src = url;
  image.alt = sticker.name || "Discord sticker";
  image.title = sticker.name || "Discord sticker";
  image.loading = "lazy";
  if (!allowSaveExpressions) return image;
  const save = document.createElement("button");
  save.type = "button";
  save.className = "message-sticker-save";
  save.title = `Save ${sticker.name || "sticker"} to Saved Expressions`;
  save.setAttribute("aria-label", `Save ${sticker.name || "sticker"} to Saved Expressions`);
  save.append(image);
  save.addEventListener("click", () => saveObservedExpression({
    id: sticker.id,
    type: "sticker",
    name: sticker.name,
  }, message));
  return save;
}

function createEmbed(embed) {
  const block = document.createElement("div");
  block.className = "message-embed";
  if (embed.color) block.style.borderLeftColor = `#${Number(embed.color).toString(16).padStart(6, "0")}`;
  let embedUrl = null;
  try {
    const parsed = new URL(embed.url);
    if (["https:", "http:"].includes(parsed.protocol)) embedUrl = parsed.toString();
  } catch {
    embedUrl = null;
  }
  if (embed.title) {
    const title = document.createElement(embedUrl ? "a" : "strong");
    title.textContent = embed.title;
    if (embedUrl) {
      title.href = embedUrl;
      title.target = "_blank";
      title.rel = "noreferrer";
    }
    block.append(title);
  }
  if (embed.description) {
    const description = document.createElement("p");
    description.textContent = embed.description;
    block.append(description);
  }
  const imageUrl = safeMediaUrl(embed.image || embed.thumbnail);
  const videoUrl = safeMediaUrl(embed.video);
  if (imageUrl) {
    const image = document.createElement("img");
    image.className = "message-embed-media";
    image.src = imageUrl;
    image.alt = embed.title || "Discord embed image";
    image.loading = "lazy";
    block.append(image);
  } else if (videoUrl) {
    const video = document.createElement("video");
    video.className = "message-embed-media";
    video.src = videoUrl;
    video.controls = true;
    video.preload = "metadata";
    video.setAttribute("playsinline", "");
    block.append(video);
  }
  return block;
}

function createMessage(message, { allowReply = true, allowSaveExpressions = true } = {}) {
  const row = document.createElement("article");
  row.className = "discord-message";
  row.dataset.messageId = message.id;

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  if (message.author.avatarUrl) {
    const image = document.createElement("img");
    image.src = message.author.avatarUrl;
    image.alt = "";
    image.width = 38;
    image.height = 38;
    avatar.append(image);
  } else {
    avatar.textContent = message.author.displayName.slice(0, 1).toUpperCase();
  }

  const body = document.createElement("div");
  body.className = "message-body";
  if (message.referencedMessage) {
    const reference = document.createElement("div");
    reference.className = "message-reference";
    const referenceAuthor = document.createElement("strong");
    referenceAuthor.textContent = message.referencedMessage.author.displayName;
    const referenceContent = document.createElement("span");
    referenceContent.textContent = message.referencedMessage.content || "Original message";
    reference.append(referenceAuthor, referenceContent);
    body.append(reference);
  }
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("strong");
  author.textContent = message.author.displayName;
  meta.append(author);
  if (message.author.bot) {
    const bot = document.createElement("span");
    bot.className = "bot-label";
    bot.textContent = "BOT";
    meta.append(bot);
  }
  const time = document.createElement("time");
  const date = new Date(message.timestamp);
  time.dateTime = message.timestamp;
  time.textContent = Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
  meta.append(time);
  body.append(meta);

  if (message.content) {
    const content = document.createElement("p");
    content.className = "message-content";
    appendDiscordContent(content, message, allowSaveExpressions);
    body.append(content);
  }
  if ((message.attachments || []).length) {
    const attachments = document.createElement("div");
    attachments.className = "message-attachments";
    attachments.append(...message.attachments.map(createAttachment));
    body.append(attachments);
  }
  if ((message.stickers || []).length) {
    const stickers = document.createElement("div");
    stickers.className = "message-stickers";
    stickers.append(...message.stickers.map((sticker) => createSticker(sticker, message, allowSaveExpressions)));
    body.append(stickers);
  }
  (message.embeds || []).forEach((embed) => body.append(createEmbed(embed)));
  if (allowReply) {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const reply = document.createElement("button");
    reply.type = "button";
    reply.append(icon("reply"), "Reply");
    reply.addEventListener("click", () => setReplyTarget(message));
    actions.append(reply);
    if (!message.author.bot && message.author.id !== workspace?.user?.id) {
      const direct = document.createElement("button");
      direct.type = "button";
      direct.append(icon("message-circle"), "Message");
      direct.addEventListener("click", () => openDirectConversation({
        id: message.author.id,
        username: message.author.username,
        displayName: message.author.displayName,
        avatarUrl: message.author.avatarUrl,
        bot: false,
      }));
      actions.append(direct);
    }
    body.append(actions);
  }
  row.append(avatar, body);
  return row;
}

function notificationKind(message) {
  if (!workspace || message.author.id === workspace.bot.id) return null;
  if (message.referencedMessage?.author?.id === workspace.bot.id) return "reply";
  if (message.mentionEveryone || message.mentions.some((mention) => [workspace.bot.id, workspace.user.id].includes(mention.id))) {
    return "mention";
  }
  return "normal";
}

function notificationEnabled(kind) {
  if (!notificationSettings.enabled) return false;
  if (kind === "mention") return notificationSettings.mentions;
  if (kind === "reply") return notificationSettings.replies;
  if (kind === "dm") return notificationSettings.directMessages;
  return notificationSettings.normalMessages;
}

function inQuietHours() {
  const quiet = notificationSettings.quietHours;
  if (!quiet?.enabled) return false;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [startHour, startMinute] = quiet.start.split(":").map(Number);
  const [endHour, endMinute] = quiet.end.split(":").map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function playNotificationTone(kind) {
  if (!notificationSettings.sounds || inQuietHours()) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const context = new AudioContext();
    const patterns = {
      normal: [[420, 0, 0.09]],
      mention: [[720, 0, 0.09], [980, 0.13, 0.14]],
      reply: [[520, 0, 0.08], [690, 0.1, 0.1]],
      dm: [[360, 0, 0.1], [520, 0.12, 0.1], [760, 0.24, 0.14]],
    };
    const gain = context.createGain();
    gain.gain.value = 0.045;
    gain.connect(context.destination);
    const startedAt = context.currentTime;
    (patterns[kind] || patterns.normal).forEach(([frequency, delay, duration]) => {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start(startedAt + delay);
      oscillator.stop(startedAt + delay + duration);
    });
    window.setTimeout(() => context.close(), 700);
  } catch {
    // Browsers may block audio until the first user gesture.
  }
}

function notifyIncoming(message, kind) {
  if (!kind || !notificationEnabled(kind) || inQuietHours()) return;
  const now = Date.now();
  const groupedFor = Math.max(3, notificationSettings.groupWindowSeconds || 8) * 1_000;
  if (now - (lastAlertAt.get(kind) || 0) < groupedFor) return;
  lastAlertAt.set(kind, now);
  playNotificationTone(kind);
  if (notificationSettings.browser && document.hidden && "Notification" in window && Notification.permission === "granted") {
    const labels = { normal: "New server message", mention: "Bot mentioned", reply: "New reply", dm: "New direct message" };
    const alert = new Notification(`${labels[kind]} - ${workspace.server.name}`, {
      body: `${message.author.displayName}: ${resolveMessageContent(message).slice(0, 140) || "New activity"}`,
      icon: "/assets/valax-logo.webp",
      tag: `valax-${guildId}-${kind}`,
    });
    alert.onclick = () => {
      window.focus();
      alert.close();
      if (!message.author.bot && message.author.id !== workspace.user.id) {
        openDirectConversation({
          id: message.author.id,
          username: message.author.username,
          displayName: message.author.displayName,
          avatarUrl: message.author.avatarUrl,
          bot: false,
        });
      }
    };
  }
}

async function loadMessages({ quiet = false } = {}) {
  if (!selectedChannel || messagesLoading) return;
  messagesLoading = true;
  refreshButton.disabled = true;
  refreshButton.classList.add("is-loading");
  if (!quiet) {
    messageLoading.hidden = false;
    messageEmpty.hidden = true;
    messageList.hidden = true;
  }
  const stickToBottom = messageStream.scrollHeight - messageStream.scrollTop - messageStream.clientHeight < 120;

  try {
    const lastId = quiet ? lastMessageIdByChannel.get(selectedChannel.id) : "";
    const query = apiQuery({ channelId: selectedChannel.id, ...(lastId ? { after: lastId } : {}) });
    const response = await fetch(`/api/server/messages?${query}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const payload = await readPayload(response);
    if (routeForApiError(response, payload)) return;
    if (!response.ok) throw new Error(payload.error || "Valax could not load recent messages.");

    if (lastId) {
      const freshMessages = payload.messages.filter((message) => !messageList.querySelector(`[data-message-id="${message.id}"]`));
      freshMessages.forEach((message) => {
        messageList.append(createMessage(message));
        notifyIncoming(message, notificationKind(message));
      });
    } else {
      messageList.replaceChildren(...payload.messages.map(createMessage));
    }
    const newest = payload.messages[payload.messages.length - 1];
    if (newest) lastMessageIdByChannel.set(selectedChannel.id, newest.id);
    messageList.hidden = false;
    messageLoading.hidden = true;
    messageEmpty.hidden = messageList.children.length > 0;
    if (!quiet || stickToBottom) messageStream.scrollTop = messageStream.scrollHeight;
    composerStatus.textContent = `Synced ${new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date())}`;
    refreshIcons();
  } catch (error) {
    messageLoading.hidden = true;
    messageList.hidden = false;
    showToast(error instanceof Error ? error.message : "Messages could not be loaded.", true);
  } finally {
    messagesLoading = false;
    refreshButton.disabled = false;
    refreshButton.classList.remove("is-loading");
  }
}

function updateModeBanner() {
  modeBanner.hidden = messageMode !== "announcement";
  if (messageMode === "announcement") {
    modeBannerText.textContent = selectedChannel?.announcement ? "Announcement mode / Publishing enabled" : "Announcement mode / Standard channel";
  }
  sendButton.setAttribute("aria-label", messageMode === "announcement" ? "Send announcement" : "Send message");
  sendButton.setAttribute("title", messageMode === "announcement" ? "Send announcement" : "Send message");
}

function setReplyTarget(message) {
  replyTarget = message || null;
  const replyView = document.querySelector("[data-composer-reply]");
  replyView.hidden = !replyTarget;
  if (replyTarget) {
    document.querySelector("[data-reply-author]").textContent = replyTarget.author.displayName;
    messageInput.focus();
  }
  refreshIcons();
}

function syncMentionIds() {
  selectedMentionIds = new Set(
    [...messageInput.value.matchAll(/<@!?(\d{17,20})>/g)].map((match) => match[1])
  );
}

function insertComposerText(value) {
  const start = messageInput.selectionStart;
  const end = messageInput.selectionEnd;
  const needsSpace = start > 0 && !/\s/.test(messageInput.value[start - 1]);
  const trailingSpace = end >= messageInput.value.length || !/\s/.test(messageInput.value[end] || "") ? " " : "";
  messageInput.setRangeText(`${needsSpace ? " " : ""}${value}${trailingSpace}`, start, end, "end");
  messageInput.focus();
  syncMentionIds();
  updateComposer();
}

function hideMentionSuggestions() {
  window.clearTimeout(mentionAutocompleteTimer);
  mentionAutocompleteController?.abort();
  mentionAutocompleteController = null;
  mentionAutocompleteTrigger = null;
  mentionAutocompleteMembers = [];
  mentionSuggestions.hidden = true;
}

function findMentionTrigger() {
  const cursor = messageInput.selectionStart;
  const beforeCursor = messageInput.value.slice(0, cursor);
  const match = beforeCursor.match(/(^|\s)(\/?@)([^\s@<>]{0,32})$/);
  if (!match) return null;
  const token = `${match[2]}${match[3]}`;
  return { start: cursor - token.length, end: cursor, query: match[3] };
}

function mentionSuggestionAvatar(member) {
  const avatar = document.createElement("span");
  avatar.className = "mention-suggestion-avatar";
  if (member.avatarUrl) {
    const image = document.createElement("img");
    image.src = member.avatarUrl;
    image.alt = "";
    image.width = 32;
    image.height = 32;
    avatar.append(image);
  } else {
    avatar.textContent = member.displayName.slice(0, 1).toUpperCase();
  }
  return avatar;
}

function selectMentionSuggestion(member) {
  const trigger = mentionAutocompleteTrigger || findMentionTrigger();
  if (!trigger) return;
  messageInput.setRangeText(`<@${member.id}> `, trigger.start, trigger.end, "end");
  selectedMentionIds.add(member.id);
  document.querySelector("[data-mention-policy]").value = "users";
  hideMentionSuggestions();
  messageInput.focus();
  updateComposer();
}

function renderMentionSuggestions(members) {
  mentionAutocompleteMembers = members.filter((member) => !member.bot).slice(0, 8);
  mentionAutocompleteIndex = 0;
  if (!mentionAutocompleteMembers.length) {
    hideMentionSuggestions();
    return;
  }
  mentionSuggestions.replaceChildren(...mentionAutocompleteMembers.map((member, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mention-suggestion${index === mentionAutocompleteIndex ? " is-active" : ""}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", index === mentionAutocompleteIndex ? "true" : "false");
    const identity = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = member.displayName;
    const username = document.createElement("small");
    username.textContent = `@${member.username}`;
    identity.append(name, username);
    const action = document.createElement("span");
    action.textContent = "MENTION";
    button.append(mentionSuggestionAvatar(member), identity, action);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => selectMentionSuggestion(member));
    return button;
  }));
  mentionSuggestions.hidden = false;
}

function setMentionSuggestionIndex(index) {
  if (!mentionAutocompleteMembers.length) return;
  mentionAutocompleteIndex = (index + mentionAutocompleteMembers.length) % mentionAutocompleteMembers.length;
  [...mentionSuggestions.children].forEach((button, itemIndex) => {
    const active = itemIndex === mentionAutocompleteIndex;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    if (active) button.scrollIntoView({ block: "nearest" });
  });
}

function queueMentionAutocomplete() {
  window.clearTimeout(mentionAutocompleteTimer);
  mentionAutocompleteController?.abort();
  const trigger = findMentionTrigger();
  if (!trigger) {
    hideMentionSuggestions();
    return;
  }
  mentionAutocompleteTrigger = trigger;
  mentionAutocompleteTimer = window.setTimeout(async () => {
    mentionAutocompleteController = new AbortController();
    try {
      const response = await fetch(`/api/server/members?${apiQuery({ ...(trigger.query ? { query: trigger.query } : {}) })}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: mentionAutocompleteController.signal,
      });
      const payload = await readPayload(response);
      if (!response.ok) throw new Error(payload.error || "Members could not be searched.");
      const current = findMentionTrigger();
      if (!current || current.start !== trigger.start || current.query !== trigger.query) return;
      renderMentionSuggestions(payload.members || []);
      refreshIcons();
    } catch (error) {
      if (error?.name !== "AbortError") hideMentionSuggestions();
    }
  }, 180);
}

function attachmentPreview(target) {
  return target === "dm" ? dmAttachmentPreview : messageAttachmentPreview;
}

function currentAttachment(target) {
  return target === "dm" ? dmAttachment : messageAttachment;
}

function clearAttachment(target) {
  const selected = currentAttachment(target);
  if (selected?.previewUrl) URL.revokeObjectURL(selected.previewUrl);
  if (target === "dm") {
    dmAttachment = null;
    if (dmFileInput) dmFileInput.value = "";
    updateDmComposer();
  } else {
    messageAttachment = null;
    if (messageFileInput) messageFileInput.value = "";
    updateComposer();
  }
  const preview = attachmentPreview(target);
  preview.hidden = true;
  preview.replaceChildren();
}

function renderAttachmentPreview(target) {
  const selected = currentAttachment(target);
  const preview = attachmentPreview(target);
  if (!selected) {
    preview.hidden = true;
    preview.replaceChildren();
    return;
  }

  const media = selected.file.type.startsWith("video/") ? document.createElement("video") : document.createElement("img");
  media.src = selected.previewUrl;
  if (media instanceof HTMLVideoElement) {
    media.muted = true;
    media.preload = "metadata";
  } else {
    media.alt = "";
  }
  const identity = document.createElement("div");
  const filename = document.createElement("strong");
  filename.textContent = selected.file.name;
  const size = document.createElement("span");
  size.textContent = `${(selected.file.size / 1024 / 1024).toFixed(2)} MB`;
  identity.append(filename, size);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.title = "Remove attachment";
  remove.setAttribute("aria-label", "Remove attachment");
  remove.append(icon("x"));
  remove.addEventListener("click", () => clearAttachment(target));
  preview.replaceChildren(media, identity, remove);
  preview.hidden = false;
  refreshIcons();
}

function selectAttachment(target, file) {
  if (!file) return;
  if (!ALLOWED_UPLOAD_TYPES.has(file.type)) {
    showToast("Choose a PNG, JPEG, WebP, AVIF, GIF, MP4, WebM, or MOV file.", true);
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    showToast("Attachments must be 4 MB or smaller.", true);
    return;
  }
  clearAttachment(target);
  const selected = { file, previewUrl: URL.createObjectURL(file) };
  if (target === "dm") dmAttachment = selected;
  else messageAttachment = selected;
  renderAttachmentPreview(target);
  if (target === "dm") updateDmComposer();
  else updateComposer();
}

function renderSelectedStickers() {
  selectedStickersView.replaceChildren(...selectedStickers.map((sticker) => {
    const item = document.createElement("div");
    const image = document.createElement("img");
    image.src = sticker.url;
    image.alt = sticker.name;
    const name = document.createElement("span");
    name.textContent = sticker.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = `Remove ${sticker.name}`;
    remove.setAttribute("aria-label", `Remove ${sticker.name}`);
    remove.append(icon("x"));
    remove.addEventListener("click", () => {
      selectedStickers = selectedStickers.filter((item) => item.id !== sticker.id);
      renderSelectedStickers();
      updateComposer();
    });
    item.append(image, name, remove);
    return item;
  }));
  selectedStickersView.hidden = selectedStickers.length === 0;
  refreshIcons();
}

async function loadExpressions() {
  if (expressions || expressionsLoading) return;
  expressionsLoading = true;
  try {
    const [serverResponse, libraryResponse] = await Promise.all([
      fetch(`/api/server/expressions?${apiQuery()}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      }),
      fetch(`/api/server/expression-library?${apiQuery()}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      }),
    ]);
    const [serverPayload, libraryPayload] = await Promise.all([
      readPayload(serverResponse),
      readPayload(libraryResponse),
    ]);
    if (routeForApiError(serverResponse, serverPayload) || routeForApiError(libraryResponse, libraryPayload)) return;
    if (!serverResponse.ok) throw new Error(serverPayload.error || "Server expressions could not be loaded.");
    if (!libraryResponse.ok) throw new Error(libraryPayload.error || "Saved Expressions could not be loaded.");
    expressions = { ...serverPayload, saved: libraryPayload.expressions || [] };
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Server expressions could not be loaded.", true);
    expressions = { emojis: [], stickers: [], saved: [], permissions: {} };
  } finally {
    expressionsLoading = false;
    renderExpressions();
  }
}

async function saveObservedExpression(expression, message) {
  if (!selectedChannel || !message?.id) return;
  const key = `${expression.type}:${expression.id}`;
  if (expressionSaveInProgress.has(key)) return;
  expressionSaveInProgress.add(key);
  try {
    const response = await fetch("/api/server/expression-library", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        guildId,
        botId: workspace.bot.id,
        channelId: selectedChannel.id,
        messageId: message.id,
        expressionId: expression.id,
        type: expression.type,
      }),
    });
    const payload = await readPayload(response);
    if (routeForApiError(response, payload)) return;
    if (!response.ok) throw new Error(payload.error || "The expression could not be saved.");
    if (expressions) {
      expressions.saved = [
        payload.expression,
        ...(expressions.saved || []).filter((item) => !(item.type === payload.expression.type && item.id === payload.expression.id)),
      ];
      if (expressionDialog.open && expressionTab === "saved") renderExpressions();
    }
    showToast(payload.alreadySaved ? `${payload.expression.name} is already saved.` : `${payload.expression.name} saved to Valax.`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "The expression could not be saved.", true);
  } finally {
    expressionSaveInProgress.delete(key);
  }
}

async function removeSavedExpression(expression) {
  try {
    const response = await fetch(`/api/server/expression-library?${apiQuery()}`, {
      method: "DELETE",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ type: expression.type, expressionId: expression.id }),
    });
    const payload = await readPayload(response);
    if (!response.ok) throw new Error(payload.error || "The saved expression could not be removed.");
    expressions.saved = expressions.saved.filter((item) => !(item.type === expression.type && item.id === expression.id));
    renderExpressions();
    showToast(`${expression.name} removed from Saved Expressions.`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "The saved expression could not be removed.", true);
  }
}

function chooseExpression(expression) {
  const type = expressionTab === "saved" ? expression.type : expressionTab;
  if (type === "emoji") {
    const markup = `<${expression.animated ? "a" : ""}:${expression.name}:${expression.id}>`;
    if (expressionTarget === "dm") insertInto(dmInput, markup);
    else insertComposerText(markup);
    closeDialog(expressionDialog);
    if (expression.access === "discord-controlled") {
      showToast("Expression inserted. Discord will verify this Bot's access when it sends.");
    }
    return;
  }
  if (expressionTarget === "dm") {
    showToast("Discord server stickers can only be selected for a server channel message.", true);
    return;
  }
  if (selectedStickers.some((sticker) => sticker.id === expression.id)) {
    selectedStickers = selectedStickers.filter((sticker) => sticker.id !== expression.id);
  } else if (selectedStickers.length < 3) {
    selectedStickers = [...selectedStickers, expression];
  } else {
    showToast("Discord allows up to three stickers in one message.", true);
    return;
  }
  renderSelectedStickers();
  updateComposer();
  closeDialog(expressionDialog);
  if (expression.access === "discord-controlled") {
    showToast("Sticker selected. Discord will verify this Bot's access when it sends.");
  }
}

function renderExpressions() {
  if (!expressionGrid) return;
  if (!expressions) {
    expressionGrid.innerHTML = '<div class="dialog-loading"><span class="workspace-spinner"></span><span>Loading expressions...</span></div>';
    return;
  }
  const query = expressionSearch.value.trim().toLowerCase();
  const source = expressionTab === "saved"
    ? expressions.saved
    : expressionTab === "sticker"
      ? expressions.stickers
      : expressions.emojis;
  const items = source.filter((item) => item.name.toLowerCase().includes(query));
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "dialog-loading";
    empty.textContent = expressionTab === "sticker" && expressions.permissions?.stickers === false
      ? "Discord denied access to server stickers. Verify the bot role permissions."
      : expressionTab === "saved"
        ? "No saved expressions yet. Click an emoji or sticker in a server message to add it."
        : `No ${expressionTab === "sticker" ? "stickers" : "emoji"} found.`;
    expressionGrid.replaceChildren(empty);
    return;
  }
  expressionGrid.replaceChildren(...items.map((item) => {
    const wrapper = document.createElement("div");
    wrapper.className = `expression-item${item.access === "discord-controlled" ? " is-discord-controlled" : ""}`;
    const button = document.createElement("button");
    button.type = "button";
    button.title = item.name;
    button.setAttribute("aria-label", item.name);
    const image = document.createElement("img");
    image.src = item.url;
    image.alt = "";
    image.loading = "lazy";
    const name = document.createElement("span");
    name.textContent = item.name;
    button.append(image, name);
    button.addEventListener("click", () => chooseExpression(item));
    wrapper.append(button);
    if (expressionTab === "saved") {
      const access = document.createElement("small");
      access.textContent = item.access === "available" ? "READY" : "DISCORD CHECK";
      wrapper.append(access);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "expression-remove";
      remove.title = `Remove ${item.name}`;
      remove.setAttribute("aria-label", `Remove ${item.name}`);
      remove.append(icon("x"));
      remove.addEventListener("click", () => removeSavedExpression(item));
      wrapper.append(remove);
    }
    return wrapper;
  }));
  refreshIcons();
}

function openExpressionPicker(target) {
  expressionTarget = target;
  expressionTab = "emoji";
  expressionDialog.classList.toggle("dm-expression", target === "dm");
  expressionSearch.value = "";
  document.querySelectorAll("[data-expression-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.expressionTab === "emoji");
    button.hidden = target === "dm" && button.dataset.expressionTab === "sticker";
  });
  if (!expressionDialog.open) expressionDialog.showModal();
  renderExpressions();
  loadExpressions();
}

function updateComposer() {
  characterCount.textContent = `${messageInput.value.length.toLocaleString()} / 2,000`;
  if (!sendInProgress) {
    sendButton.disabled = !selectedChannel
      || (!messageInput.value.trim() && !messageAttachment && selectedStickers.length === 0);
  }
}

function setSendBusy(isBusy) {
  sendInProgress = isBusy;
  sendButton.disabled = isBusy;
  sendButton.classList.toggle("is-loading", isBusy);
  sendButton.replaceChildren(icon(isBusy ? "loader-circle" : "send"));
  composerStatus.textContent = isBusy ? "Sending through Discord..." : "Ready";
  refreshIcons();
}

async function sendMessage() {
  const content = messageInput.value.trim();
  if (!selectedChannel || (!content && !messageAttachment && selectedStickers.length === 0) || sendInProgress) return;
  const mentionPolicy = document.querySelector("[data-mention-policy]").value;
  const rawMention = content.match(/(?:^|\s)\/?@([^\s@<>]+)/);
  if (rawMention && !["everyone", "here"].includes(rawMention[1].toLowerCase())) {
    showToast("Select the member from the @ suggestions so Discord receives a real user mention.", true);
    messageInput.focus();
    queueMentionAutocomplete();
    return;
  }
  if (selectedMentionIds.size && mentionPolicy === "none") {
    showToast("Change Mention policy to User mentions before sending.", true);
    return;
  }
  if (/@(?:everyone|here)\b/i.test(content) && mentionPolicy !== "all") {
    showToast("Change Mention policy to All mentions before sending @everyone or @here.", true);
    return;
  }
  setSendBusy(true);

  try {
    const requestPayload = {
      guildId,
      botId: workspace.bot.id,
      channelId: selectedChannel.id,
      content,
      mode: messageMode,
      mentionPolicy,
      mentionIds: [...selectedMentionIds],
      stickerIds: selectedStickers.map((sticker) => sticker.id),
      replyToId: replyTarget?.id || null,
      notifyReplyAuthor: document.querySelector("[data-notify-reply]").checked,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    const requestOptions = messageAttachment
      ? (() => {
          const form = new FormData();
          form.append("payload", JSON.stringify(requestPayload));
          form.append("file", messageAttachment.file, messageAttachment.file.name);
          return { body: form };
        })()
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestPayload),
        };
    const response = await fetch("/api/server/messages", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(requestOptions.headers || {}) },
      body: requestOptions.body,
    });
    const payload = await readPayload(response);
    if (routeForApiError(response, payload)) return;
    if (!response.ok) throw new Error(payload.error || "Discord could not send this message.");

    messageInput.value = "";
    clearAttachment("message");
    selectedStickers = [];
    renderSelectedStickers();
    selectedMentionIds.clear();
    setReplyTarget(null);
    updateComposer();
    messageEmpty.hidden = true;
    messageList.hidden = false;
    if (!messageList.querySelector(`[data-message-id="${payload.message.id}"]`)) {
      messageList.append(createMessage(payload.message));
    }
    messageStream.scrollTop = messageStream.scrollHeight;
    const mentionDelivery = payload.mentionDelivery || {};
    const mentionMismatch = mentionDelivery.notificationsEnabled
      && mentionDelivery.requested > mentionDelivery.resolved;
    let sentLabel = messageMode === "announcement" && payload.published ? "Announcement published." : "Message sent.";
    if (mentionMismatch) {
      sentLabel = "Message sent, but Discord could not resolve every requested mention.";
    } else if (mentionDelivery.notificationsEnabled && mentionDelivery.resolved > 0) {
      sentLabel = `Message sent with ${mentionDelivery.resolved} member notification${mentionDelivery.resolved === 1 ? "" : "s"}.`;
    } else if (mentionDelivery.replyNotificationEnabled) {
      sentLabel = "Reply sent with author notification.";
    }
    showToast(sentLabel, mentionMismatch);
    composerStatus.textContent = "Delivered";
    refreshIcons();
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Discord could not send this message.", true);
    composerStatus.textContent = "Send failed";
  } finally {
    setSendBusy(false);
    updateComposer();
  }
}

function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
}

function memberAvatar(member) {
  const avatar = document.createElement("span");
  avatar.className = "member-avatar";
  if (member.avatarUrl) {
    const image = document.createElement("img");
    image.src = member.avatarUrl;
    image.alt = "";
    image.width = 36;
    image.height = 36;
    avatar.append(image);
  } else {
    avatar.textContent = member.displayName.slice(0, 1).toUpperCase();
  }
  return avatar;
}

function createMemberRow(member) {
  const row = document.createElement("div");
  row.className = "member-row";
  const identity = document.createElement("div");
  identity.className = "member-identity";
  const name = document.createElement("strong");
  name.textContent = member.displayName;
  const username = document.createElement("span");
  username.textContent = `@${member.username}`;
  identity.append(name, username);

  const mention = document.createElement("button");
  mention.type = "button";
  mention.title = `Mention ${member.displayName}`;
  mention.setAttribute("aria-label", `Mention ${member.displayName}`);
  mention.append(icon("at-sign"));
  mention.addEventListener("click", () => {
    insertComposerText(`<@${member.id}>`);
    document.querySelector("[data-mention-policy]").value = "users";
    closeDialog(memberDialog);
  });

  const dm = document.createElement("button");
  dm.type = "button";
  dm.title = `Message ${member.displayName}`;
  dm.setAttribute("aria-label", `Message ${member.displayName}`);
  dm.append(icon("message-circle"));
  dm.addEventListener("click", () => openDirectConversation(member));
  row.append(memberAvatar(member), identity, mention, dm);
  return row;
}

async function loadMembers({ append = false } = {}) {
  if (!workspace) return;
  if (!append) {
    memberAfter = null;
    memberList.innerHTML = '<div class="dialog-loading"><span class="workspace-spinner"></span><span>Loading members...</span></div>';
  }
  const queryValue = memberSearch.value.trim();
  try {
    const response = await fetch(`/api/server/members?${apiQuery({
      ...(queryValue ? { query: queryValue } : {}),
      ...(append && memberAfter ? { after: memberAfter } : {}),
    })}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
    const payload = await readPayload(response);
    if (routeForApiError(response, payload)) return;
    if (!response.ok) throw new Error(payload.error || "Members could not be loaded.");
    const rows = payload.members.filter((member) => !member.bot).map(createMemberRow);
    if (append) memberList.append(...rows);
    else memberList.replaceChildren(...rows);
    if (!rows.length && !append) {
      const empty = document.createElement("div");
      empty.className = "dialog-loading";
      empty.textContent = "No members found.";
      memberList.replaceChildren(empty);
    }
    memberAfter = payload.nextAfter;
    document.querySelector("[data-load-more-members]").hidden = !memberAfter || Boolean(queryValue);
    refreshIcons();
  } catch (error) {
    const failure = document.createElement("div");
    failure.className = "dialog-loading";
    failure.textContent = error instanceof Error ? error.message : "Members could not be loaded.";
    if (!append) memberList.replaceChildren(failure);
    else showToast(failure.textContent, true);
  }
}

function openMemberDirectory() {
  if (!memberDialog.open) memberDialog.showModal();
  loadMembers();
}

function createRecentConversation(conversation) {
  const member = {
    id: conversation.recipientId,
    username: conversation.username,
    displayName: conversation.displayName,
    avatarUrl: conversation.avatarUrl,
    bot: false,
  };
  const button = document.createElement("button");
  button.type = "button";
  button.className = activeDmMember?.id === member.id ? "is-active" : "";
  button.title = `Message ${member.displayName}`;
  button.setAttribute("aria-label", `Message ${member.displayName}`);
  button.append(memberAvatar(member));
  const name = document.createElement("span");
  name.textContent = member.displayName;
  button.append(name);
  button.addEventListener("click", () => openDirectConversation(member));
  return button;
}

async function loadRecentDirectConversations() {
  if (!workspace) return;
  try {
    const response = await fetch(`/api/server/dm-recent?${apiQuery()}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const payload = await readPayload(response);
    if (!response.ok) return;
    const conversations = payload.conversations || [];
    const section = document.querySelector("[data-recent-dm-section]");
    section.hidden = conversations.length === 0;
    document.querySelector("[data-recent-dm-list]").replaceChildren(...conversations.map(createRecentConversation));
  } catch {
    // Recent conversations are an optional shortcut; the member directory remains available.
  }
}

async function loadDirectConversation({ quiet = false } = {}) {
  if (!activeDmMember || (quiet && dmLoading)) return;
  const recipientId = activeDmMember.id;
  const requestSequence = ++dmRequestSequence;
  dmLoading = true;
  try {
    const response = await fetch(`/api/server/dm?${apiQuery({
      recipientId: activeDmMember.id,
      ...(quiet && activeDmLastId ? { after: activeDmLastId } : {}),
    })}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const payload = await readPayload(response);
    if (requestSequence !== dmRequestSequence || activeDmMember?.id !== recipientId) return;
    if (routeForApiError(response, payload)) return;
    if (!response.ok) throw new Error(payload.error || "This direct conversation could not be loaded.");
    const newest = payload.messages[payload.messages.length - 1];
    if (quiet && !newest) return;
    if (quiet && newest && newest.author.id !== workspace.bot.id) notifyIncoming(newest, "dm");
    activeDmLastId = newest?.id || null;
    if (quiet) {
      payload.messages.forEach((message) => {
        if (!dmMessageList.querySelector(`[data-message-id="${message.id}"]`)) {
          dmMessageList.append(createMessage(message, { allowReply: false, allowSaveExpressions: false }));
        }
      });
    } else {
      dmMessageList.replaceChildren(...payload.messages.map((message) => createMessage(message, { allowReply: false, allowSaveExpressions: false })));
    }
    const optOut = document.querySelector("[data-dm-opt-out]");
    if (payload.optedOut !== null) {
      optOut.hidden = !payload.optedOut;
      dmInput.disabled = payload.optedOut;
    }
    updateDmComposer();
    dmMessageList.scrollTop = dmMessageList.scrollHeight;
    if (!quiet) loadRecentDirectConversations();
    refreshIcons();
  } catch (error) {
    if (!quiet) showToast(error instanceof Error ? error.message : "This direct conversation could not be loaded.", true);
  } finally {
    if (requestSequence === dmRequestSequence) dmLoading = false;
  }
}

function openDirectConversation(member) {
  const recipientChanged = activeDmMember?.id !== member.id;
  if (recipientChanged) {
    dmInput.value = "";
    clearAttachment("dm");
  }
  activeDmMember = member;
  activeDmLastId = null;
  dmInput.disabled = false;
  document.querySelector("[data-dm-opt-out]").hidden = true;
  closeDialog(memberDialog);
  document.querySelector("[data-dm-member-name]").textContent = member.displayName;
  const avatar = document.querySelector("[data-dm-member-avatar]");
  avatar.className = "dm-member-avatar";
  replaceAvatar(avatar, member.avatarUrl, `${member.displayName} avatar`, "user");
  dmMessageList.innerHTML = '<div class="dialog-loading"><span class="workspace-spinner"></span><span>Loading conversation...</span></div>';
  if (!dmDialog.open) dmDialog.showModal();
  updateDmComposer();
  loadRecentDirectConversations();
  loadDirectConversation();
}

function updateDmComposer() {
  const button = document.querySelector("[data-send-dm]");
  if (!button || button.classList.contains("is-loading")) return;
  button.disabled = !activeDmMember || dmInput.disabled || (!dmInput.value.trim() && !dmAttachment);
}

async function sendDirectMessage() {
  const content = dmInput.value.trim();
  if (!activeDmMember || (!content && !dmAttachment)) return;
  const button = document.querySelector("[data-send-dm]");
  button.disabled = true;
  button.classList.add("is-loading");
  button.replaceChildren(icon("loader-circle"));
  refreshIcons();
  try {
    const requestPayload = {
      guildId,
      botId: workspace.bot.id,
      recipientId: activeDmMember.id,
      content,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    const requestOptions = dmAttachment
      ? (() => {
          const form = new FormData();
          form.append("payload", JSON.stringify(requestPayload));
          form.append("file", dmAttachment.file, dmAttachment.file.name);
          return { body: form };
        })()
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestPayload),
        };
    const response = await fetch("/api/server/dm", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(requestOptions.headers || {}) },
      body: requestOptions.body,
    });
    const payload = await readPayload(response);
    if (routeForApiError(response, payload)) return;
    if (!response.ok) throw new Error(payload.error || "Discord could not deliver this direct message.");
    dmInput.value = "";
    clearAttachment("dm");
    await loadDirectConversation();
    loadRecentDirectConversations();
    showToast("Direct message delivered.");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Discord could not deliver this direct message.", true);
  } finally {
    button.disabled = false;
    button.classList.remove("is-loading");
    button.replaceChildren(icon("send"));
    updateDmComposer();
    refreshIcons();
  }
}

function insertInto(input, value) {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const needsSpace = start > 0 && !/\s/.test(input.value[start - 1]);
  input.setRangeText(`${needsSpace ? " " : ""}${value} `, start, end, "end");
  input.focus();
}

function openCampaignDialog() {
  window.clearTimeout(campaignTimer);
  activeCampaign = null;
  document.querySelector("[data-campaign-form]").hidden = false;
  document.querySelector("[data-campaign-confirm]").hidden = true;
  document.querySelector("[data-campaign-progress]").hidden = true;
  document.querySelector("[data-campaign-confirmation]").value = "";
  if (!campaignDialog.open) campaignDialog.showModal();
}

async function resumeActiveCampaign() {
  try {
    const response = await fetch(`/api/server/dm-campaigns?${apiQuery()}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const payload = await readPayload(response);
    if (!response.ok || !payload.campaign || !["queued", "running"].includes(payload.campaign.status)) return;
    activeCampaign = payload.campaign;
    if (!campaignDialog.open) campaignDialog.showModal();
    renderCampaignProgress(payload.campaign);
    processCampaign();
  } catch {
    // A confirmed campaign can be resumed the next time this workspace opens.
  }
}

async function previewCampaign() {
  const content = document.querySelector("[data-campaign-input]").value.trim();
  if (!content) {
    showToast("Enter a notification message before reviewing recipients.", true);
    return;
  }
  const button = document.querySelector("[data-preview-campaign]");
  button.disabled = true;
  try {
    const response = await fetch("/api/server/dm-campaigns", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preview", guildId, botId: workspace.bot.id }),
    });
    const payload = await readPayload(response);
    if (routeForApiError(response, payload)) return;
    if (!response.ok) throw new Error(payload.error || "Recipient preview could not be prepared.");
    document.querySelector("[data-campaign-count]").textContent = `${payload.eligibleRecipients.toLocaleString()} eligible members`;
    document.querySelector("[data-campaign-limit]").textContent = payload.truncated ? "Limited to the first 1,000 eligible members" : "All eligible members included";
    document.querySelector("[data-campaign-server-name]").textContent = payload.confirmation;
    document.querySelector("[data-campaign-confirmation]").dataset.expected = payload.confirmation;
    document.querySelector("[data-campaign-confirm]").hidden = false;
    document.querySelector("[data-campaign-confirmation]").focus();
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Recipient preview could not be prepared.", true);
  } finally {
    button.disabled = false;
  }
}

function renderCampaignProgress(campaign) {
  activeCampaign = campaign;
  const total = campaign.recipientCount || 0;
  const processed = campaign.processed || 0;
  const progress = document.querySelector("[data-campaign-progress]");
  progress.hidden = false;
  document.querySelector("[data-campaign-form]").hidden = true;
  document.querySelector("[data-campaign-status]").textContent = campaign.status === "completed"
    ? "Notification completed"
    : campaign.status === "cancelled"
      ? "Notification cancelled"
      : "Delivering with Discord safeguards";
  document.querySelector("[data-campaign-progress-label]").textContent = `${processed.toLocaleString()} / ${total.toLocaleString()} processed`;
  const bar = document.querySelector("[data-campaign-progress-bar]");
  bar.value = total ? Math.round(processed / total * 100) : 0;
  document.querySelector("[data-campaign-sent]").textContent = String(campaign.sent || 0);
  document.querySelector("[data-campaign-failed]").textContent = String(campaign.failed || 0);
  document.querySelector("[data-campaign-skipped]").textContent = String((campaign.skipped || 0) + (campaign.optedOut || 0));
  document.querySelector("[data-cancel-campaign]").hidden = ["completed", "cancelled"].includes(campaign.status);
}

async function processCampaign() {
  if (!activeCampaign || ["completed", "cancelled"].includes(activeCampaign.status)) return;
  window.clearTimeout(campaignTimer);
  try {
    const response = await fetch("/api/server/dm-campaigns", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "process", campaignId: activeCampaign.id }),
    });
    const payload = await readPayload(response);
    if (routeForApiError(response, payload)) return;
    if (payload.campaign) renderCampaignProgress(payload.campaign);
    if (response.status === 429) {
      campaignTimer = window.setTimeout(processCampaign, Math.max(1, payload.retryAfter || 1) * 1_000);
      return;
    }
    if (response.status === 409 && payload.code === "CAMPAIGN_BUSY") {
      campaignTimer = window.setTimeout(processCampaign, 1_200);
      return;
    }
    if (!response.ok) throw new Error(payload.error || "Campaign delivery paused unexpectedly.");
    if (payload.campaign.status === "completed") {
      showToast(`Notification complete: ${payload.campaign.sent} delivered.`);
      return;
    }
    campaignTimer = window.setTimeout(processCampaign, Math.max(1, payload.retryAfter || 1) * 1_000);
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Campaign delivery paused unexpectedly.", true);
    campaignTimer = window.setTimeout(processCampaign, 5_000);
  }
}

async function createCampaign() {
  const content = document.querySelector("[data-campaign-input]").value.trim();
  const confirmation = document.querySelector("[data-campaign-confirmation]").value.trim();
  const button = document.querySelector("[data-start-campaign]");
  button.disabled = true;
  try {
    const response = await fetch("/api/server/dm-campaigns", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        guildId,
        botId: workspace.bot.id,
        content,
        confirmation,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    const payload = await readPayload(response);
    if (routeForApiError(response, payload)) return;
    if (!response.ok) throw new Error(payload.error || "The notification campaign could not be started.");
    renderCampaignProgress(payload.campaign);
    processCampaign();
  } catch (error) {
    showToast(error instanceof Error ? error.message : "The notification campaign could not be started.", true);
    button.disabled = false;
  }
}

async function cancelCampaign() {
  if (!activeCampaign) return;
  window.clearTimeout(campaignTimer);
  try {
    const response = await fetch("/api/server/dm-campaigns", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel", campaignId: activeCampaign.id }),
    });
    const payload = await readPayload(response);
    if (!response.ok) throw new Error(payload.error || "Campaign could not be cancelled.");
    renderCampaignProgress(payload.campaign);
    showToast("Notification campaign cancelled.");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Campaign could not be cancelled.", true);
  }
}

function updateNotificationPermission() {
  const label = document.querySelector("[data-notification-permission]");
  const button = document.querySelector("[data-request-notifications]");
  if (!label || !button) return;
  if (!("Notification" in window)) {
    label.textContent = "This browser does not support desktop alerts.";
    button.disabled = true;
    button.hidden = true;
    return;
  }
  const states = {
    granted: "Allowed for this browser while Valax is open.",
    denied: "Blocked in browser settings. Change the site permission to enable alerts.",
    default: "Permission has not been requested yet.",
  };
  label.textContent = states[Notification.permission] || states.default;
  button.hidden = Notification.permission === "granted";
  button.disabled = Notification.permission === "denied";
}

async function requestNotificationPermission() {
  if (!("Notification" in window) || Notification.permission === "denied") return;
  try {
    const permission = await Notification.requestPermission();
    updateNotificationPermission();
    if (permission === "granted") {
      playNotificationTone("mention");
      showToast("Browser alerts are now allowed.");
    }
  } catch {
    showToast("The browser could not update notification permission.", true);
  }
}

function fillNotificationForm() {
  document.querySelectorAll("[data-setting]").forEach((input) => {
    input.checked = notificationSettings[input.dataset.setting] === true;
  });
  document.querySelector("[data-quiet-enabled]").checked = notificationSettings.quietHours?.enabled === true;
  document.querySelector("[data-quiet-start]").value = notificationSettings.quietHours?.start || "22:00";
  document.querySelector("[data-quiet-end]").value = notificationSettings.quietHours?.end || "08:00";
}

async function loadNotificationSettings() {
  try {
    const response = await fetch(`/api/server/notifications?${apiQuery()}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const payload = await readPayload(response);
    if (response.ok && payload.settings) {
      notificationSettings = payload.settings;
      fillNotificationForm();
    }
  } catch {
    // Defaults remain active while the settings service is unavailable.
  }
}

async function saveNotificationSettings() {
  const settings = Object.fromEntries(
    [...document.querySelectorAll("[data-setting]")].map((input) => [input.dataset.setting, input.checked])
  );
  settings.groupWindowSeconds = notificationSettings.groupWindowSeconds || 8;
  settings.quietHours = {
    enabled: document.querySelector("[data-quiet-enabled]").checked,
    start: document.querySelector("[data-quiet-start]").value || "22:00",
    end: document.querySelector("[data-quiet-end]").value || "08:00",
  };
  try {
    const response = await fetch(`/api/server/notifications?${apiQuery()}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    });
    const payload = await readPayload(response);
    if (!response.ok) throw new Error(payload.error || "Notification settings could not be saved.");
    notificationSettings = payload.settings;
    closeDialog(notificationDialog);
    playNotificationTone("mention");
    showToast("Notification settings saved.");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Notification settings could not be saved.", true);
  }
}

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    messageMode = button.dataset.mode;
    document.querySelectorAll("[data-mode]").forEach((item) => item.classList.toggle("is-active", item === button));
    updateModeBanner();
  });
});

document.querySelectorAll("[data-token]").forEach((button) => {
  button.addEventListener("click", () => {
    insertComposerText(button.dataset.token);
  });
});

document.querySelectorAll("[data-open-members]").forEach((button) => button.addEventListener("click", openMemberDirectory));
document.querySelector("[data-close-members]")?.addEventListener("click", () => closeDialog(memberDialog));
document.querySelector("[data-load-more-members]")?.addEventListener("click", () => loadMembers({ append: true }));
memberSearch?.addEventListener("input", () => {
  window.clearTimeout(memberSearchTimer);
  memberSearchTimer = window.setTimeout(() => loadMembers(), 320);
});

document.querySelector("[data-close-dm]")?.addEventListener("click", () => {
  closeDialog(dmDialog);
  activeDmMember = null;
  activeDmLastId = null;
  dmInput.value = "";
  clearAttachment("dm");
});
document.querySelector("[data-dm-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  sendDirectMessage();
});
document.querySelectorAll("[data-dm-token]").forEach((button) => {
  button.addEventListener("click", () => insertInto(dmInput, button.dataset.dmToken));
});
dmInput?.addEventListener("input", updateDmComposer);

document.querySelector("[data-choose-message-file]")?.addEventListener("click", () => messageFileInput.click());
document.querySelector("[data-choose-dm-file]")?.addEventListener("click", () => dmFileInput.click());
messageFileInput?.addEventListener("change", () => selectAttachment("message", messageFileInput.files?.[0]));
dmFileInput?.addEventListener("change", () => selectAttachment("dm", dmFileInput.files?.[0]));
document.querySelectorAll("[data-open-expressions]").forEach((button) => {
  button.addEventListener("click", () => openExpressionPicker(button.dataset.openExpressions));
});
document.querySelector("[data-close-expressions]")?.addEventListener("click", () => closeDialog(expressionDialog));
document.querySelectorAll("[data-expression-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    expressionTab = button.dataset.expressionTab;
    document.querySelectorAll("[data-expression-tab]").forEach((item) => item.classList.toggle("is-active", item === button));
    renderExpressions();
  });
});
expressionSearch?.addEventListener("input", renderExpressions);

[[messageForm, "message"], [document.querySelector("[data-dm-form]"), "dm"]].forEach(([form, target]) => {
  form?.addEventListener("dragover", (event) => {
    if (![...event.dataTransfer.items].some((item) => item.kind === "file")) return;
    event.preventDefault();
    form.classList.add("is-dragging-file");
  });
  form?.addEventListener("dragleave", (event) => {
    if (!form.contains(event.relatedTarget)) form.classList.remove("is-dragging-file");
  });
  form?.addEventListener("drop", (event) => {
    form.classList.remove("is-dragging-file");
    const file = [...event.dataTransfer.files][0];
    if (!file) return;
    event.preventDefault();
    selectAttachment(target, file);
  });
});
[[messageInput, "message"], [dmInput, "dm"]].forEach(([input, target]) => {
  input?.addEventListener("paste", (event) => {
    const file = [...event.clipboardData.items]
      .find((item) => item.kind === "file" && ALLOWED_UPLOAD_TYPES.has(item.type))
      ?.getAsFile();
    if (file) selectAttachment(target, file);
  });
});

document.querySelector("[data-open-campaign]")?.addEventListener("click", openCampaignDialog);
document.querySelector("[data-close-campaign]")?.addEventListener("click", () => closeDialog(campaignDialog));
document.querySelector("[data-preview-campaign]")?.addEventListener("click", previewCampaign);
document.querySelector("[data-campaign-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  createCampaign();
});
document.querySelector("[data-campaign-confirmation]")?.addEventListener("input", (event) => {
  document.querySelector("[data-start-campaign]").disabled = event.currentTarget.value.trim() !== event.currentTarget.dataset.expected;
});
document.querySelector("[data-cancel-campaign]")?.addEventListener("click", cancelCampaign);
document.querySelectorAll("[data-campaign-token]").forEach((button) => {
  button.addEventListener("click", () => insertInto(document.querySelector("[data-campaign-input]"), button.dataset.campaignToken));
});

document.querySelector("[data-open-notifications]")?.addEventListener("click", () => {
  fillNotificationForm();
  updateNotificationPermission();
  if (!notificationDialog.open) notificationDialog.showModal();
});
document.querySelector("[data-request-notifications]")?.addEventListener("click", requestNotificationPermission);
document.querySelector("[data-close-notifications]")?.addEventListener("click", () => closeDialog(notificationDialog));
document.querySelector("[data-notification-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  saveNotificationSettings();
});

[memberDialog, dmDialog, expressionDialog, campaignDialog, notificationDialog].forEach((dialog) => {
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
});

messageInput?.addEventListener("input", () => {
  syncMentionIds();
  updateComposer();
  queueMentionAutocomplete();
});
messageInput?.addEventListener("keydown", (event) => {
  if (!mentionSuggestions.hidden) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMentionSuggestionIndex(mentionAutocompleteIndex + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setMentionSuggestionIndex(mentionAutocompleteIndex - 1);
      return;
    }
    if (["Enter", "Tab"].includes(event.key) && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      selectMentionSuggestion(mentionAutocompleteMembers[mentionAutocompleteIndex]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      hideMentionSuggestions();
      return;
    }
  }
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendMessage();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (event.target !== messageInput && !mentionSuggestions.contains(event.target)) hideMentionSuggestions();
});
messageForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});
refreshButton?.addEventListener("click", () => loadMessages());
document.querySelector("[data-cancel-reply]")?.addEventListener("click", () => setReplyTarget(null));
document.querySelector("[data-workspace-retry]")?.addEventListener("click", loadWorkspace);
workspaceBotSelector?.addEventListener("change", (event) => {
  leaveFor(`/server?guildId=${encodeURIComponent(guildId)}&botId=${encodeURIComponent(event.currentTarget.value)}`);
});

document.querySelector("[data-workspace-logout]")?.addEventListener("click", async (event) => {
  event.currentTarget.disabled = true;
  try {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  } finally {
    leaveFor("/login");
  }
});

const workspaceMenuButton = document.querySelector("[data-workspace-menu]");
const workspaceScrim = document.querySelector("[data-workspace-scrim]");
function setWorkspaceMenu(open) {
  document.body.classList.toggle("workspace-nav-open", open);
  workspaceScrim.hidden = !open;
  const label = open ? "Close server navigation" : "Open server navigation";
  workspaceMenuButton.setAttribute("aria-label", label);
  workspaceMenuButton.setAttribute("title", label);
  workspaceMenuButton.replaceChildren(icon(open ? "x" : "panel-left"));
  refreshIcons();
}
workspaceMenuButton?.addEventListener("click", () => setWorkspaceMenu(!document.body.classList.contains("workspace-nav-open")));
workspaceScrim?.addEventListener("click", () => setWorkspaceMenu(false));

window.setInterval(() => {
  const now = Date.now();
  const shouldSync = !document.hidden || now - lastBackgroundSyncAt >= 15_000;
  if (!shouldSync) return;
  if (document.hidden) lastBackgroundSyncAt = now;
  if (selectedChannel && !sendInProgress) loadMessages({ quiet: true });
  if (activeDmMember && dmDialog.open) loadDirectConversation({ quiet: true });
}, 3_000);

window.addEventListener("beforeunload", () => {
  if (messageAttachment?.previewUrl) URL.revokeObjectURL(messageAttachment.previewUrl);
  if (dmAttachment?.previewUrl) URL.revokeObjectURL(dmAttachment.previewUrl);
});

loadWorkspace();
updateComposer();
updateDmComposer();
updateNotificationPermission();
refreshIcons();
