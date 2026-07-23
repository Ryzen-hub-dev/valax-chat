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
const workspaceBotSelector = document.querySelector("[data-workspace-bot-selector]");
const mentionSuggestions = document.querySelector("[data-mention-suggestions]");

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
  return message.mentions.reduce(
    (content, mention) => content.replaceAll(`<@${mention.id}>`, `@${mention.displayName}`),
    message.content
  );
}

function createAttachment(attachment) {
  let attachmentUrl;
  try {
    const parsed = new URL(attachment.url);
    if (!["https:", "http:"].includes(parsed.protocol)) return document.createTextNode(attachment.filename);
    attachmentUrl = parsed.toString();
  } catch {
    return document.createTextNode(attachment.filename);
  }

  if (attachment.contentType?.startsWith("image/")) {
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
  const link = document.createElement("a");
  link.className = "message-attachment-file";
  link.href = attachmentUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.append(icon("paperclip"), attachment.filename);
  return link;
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
  return block;
}

function createMessage(message, { allowReply = true } = {}) {
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

  const resolvedContent = resolveMessageContent(message);
  if (resolvedContent) {
    const content = document.createElement("p");
    content.className = "message-content";
    content.textContent = resolvedContent;
    body.append(content);
  }
  if (message.attachments.length) {
    const attachments = document.createElement("div");
    attachments.className = "message-attachments";
    attachments.append(...message.attachments.map(createAttachment));
    body.append(attachments);
  }
  message.embeds.forEach((embed) => body.append(createEmbed(embed)));
  if (allowReply) {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const reply = document.createElement("button");
    reply.type = "button";
    reply.append(icon("reply"), "Reply");
    reply.addEventListener("click", () => setReplyTarget(message));
    actions.append(reply);
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
    new Notification(`${labels[kind]} - ${workspace.server.name}`, {
      body: `${message.author.displayName}: ${resolveMessageContent(message).slice(0, 140) || "New activity"}`,
      icon: "/assets/valax-logo.webp",
      tag: `valax-${guildId}-${kind}`,
    });
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

function updateComposer() {
  characterCount.textContent = `${messageInput.value.length.toLocaleString()} / 2,000`;
  if (!sendInProgress) sendButton.disabled = !selectedChannel || messageInput.value.trim().length === 0;
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
  if (!selectedChannel || !content || sendInProgress) return;
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
    const response = await fetch("/api/server/messages", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        guildId,
        botId: workspace.bot.id,
        channelId: selectedChannel.id,
        content,
        mode: messageMode,
        mentionPolicy,
        mentionIds: [...selectedMentionIds],
        replyToId: replyTarget?.id || null,
        notifyReplyAuthor: document.querySelector("[data-notify-reply]").checked,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    const payload = await readPayload(response);
    if (routeForApiError(response, payload)) return;
    if (!response.ok) throw new Error(payload.error || "Discord could not send this message.");

    messageInput.value = "";
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

async function loadDirectConversation({ quiet = false } = {}) {
  if (!activeDmMember || dmLoading) return;
  dmLoading = true;
  try {
    const response = await fetch(`/api/server/dm?${apiQuery({ recipientId: activeDmMember.id })}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const payload = await readPayload(response);
    if (routeForApiError(response, payload)) return;
    if (!response.ok) throw new Error(payload.error || "This direct conversation could not be loaded.");
    const newest = payload.messages[payload.messages.length - 1];
    if (quiet && newest?.id === activeDmLastId) return;
    if (quiet && newest && activeDmLastId && newest.author.id !== workspace.bot.id) notifyIncoming(newest, "dm");
    activeDmLastId = newest?.id || null;
    dmMessageList.replaceChildren(...payload.messages.map((message) => createMessage(message, { allowReply: false })));
    const optOut = document.querySelector("[data-dm-opt-out]");
    optOut.hidden = !payload.optedOut;
    dmInput.disabled = payload.optedOut;
    document.querySelector("[data-send-dm]").disabled = payload.optedOut;
    dmMessageList.scrollTop = dmMessageList.scrollHeight;
    refreshIcons();
  } catch (error) {
    if (!quiet) showToast(error instanceof Error ? error.message : "This direct conversation could not be loaded.", true);
  } finally {
    dmLoading = false;
  }
}

function openDirectConversation(member) {
  activeDmMember = member;
  activeDmLastId = null;
  closeDialog(memberDialog);
  document.querySelector("[data-dm-member-name]").textContent = member.displayName;
  const avatar = document.querySelector("[data-dm-member-avatar]");
  avatar.className = "dm-member-avatar";
  replaceAvatar(avatar, member.avatarUrl, `${member.displayName} avatar`, "user");
  dmMessageList.innerHTML = '<div class="dialog-loading"><span class="workspace-spinner"></span><span>Loading conversation...</span></div>';
  if (!dmDialog.open) dmDialog.showModal();
  loadDirectConversation();
}

async function sendDirectMessage() {
  const content = dmInput.value.trim();
  if (!activeDmMember || !content) return;
  const button = document.querySelector("[data-send-dm]");
  button.disabled = true;
  button.classList.add("is-loading");
  button.replaceChildren(icon("loader-circle"));
  refreshIcons();
  try {
    const response = await fetch("/api/server/dm", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        guildId,
        botId: workspace.bot.id,
        recipientId: activeDmMember.id,
        content,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    const payload = await readPayload(response);
    if (routeForApiError(response, payload)) return;
    if (!response.ok) throw new Error(payload.error || "Discord could not deliver this direct message.");
    dmInput.value = "";
    await loadDirectConversation();
    showToast("Direct message delivered.");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Discord could not deliver this direct message.", true);
  } finally {
    button.disabled = false;
    button.classList.remove("is-loading");
    button.replaceChildren(icon("send"));
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
  if (settings.browser && "Notification" in window && Notification.permission === "default") {
    await Notification.requestPermission();
  }
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
});
document.querySelector("[data-dm-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  sendDirectMessage();
});
document.querySelectorAll("[data-dm-token]").forEach((button) => {
  button.addEventListener("click", () => insertInto(dmInput, button.dataset.dmToken));
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
  if (!notificationDialog.open) notificationDialog.showModal();
});
document.querySelector("[data-close-notifications]")?.addEventListener("click", () => closeDialog(notificationDialog));
document.querySelector("[data-notification-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  saveNotificationSettings();
});

[memberDialog, dmDialog, campaignDialog, notificationDialog].forEach((dialog) => {
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

loadWorkspace();
updateComposer();
refreshIcons();
