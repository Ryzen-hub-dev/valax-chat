const params = new URLSearchParams(window.location.search);
const guildId = params.get("guildId") || "";
const requestedChannelId = params.get("channelId") || "";

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

let workspace = null;
let selectedChannel = null;
let messageMode = "message";
let messagesLoading = false;
let sendInProgress = false;
let toastTimer = null;

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
    if (server.id !== workspace.server.id) leaveFor(`/server?guildId=${encodeURIComponent(server.id)}`);
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
    const response = await fetch(`/api/server?guildId=${encodeURIComponent(guildId)}`, {
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

function createMessage(message) {
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
  row.append(avatar, body);
  return row;
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
    const query = new URLSearchParams({ guildId, channelId: selectedChannel.id });
    const response = await fetch(`/api/server/messages?${query}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const payload = await readPayload(response);
    if (routeForApiError(response, payload)) return;
    if (!response.ok) throw new Error(payload.error || "Valax could not load recent messages.");

    messageList.replaceChildren(...payload.messages.map(createMessage));
    messageList.hidden = false;
    messageLoading.hidden = true;
    messageEmpty.hidden = payload.messages.length > 0;
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
  setSendBusy(true);

  try {
    const response = await fetch("/api/server/messages", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        guildId,
        channelId: selectedChannel.id,
        content,
        mode: messageMode,
        mentionPolicy: document.querySelector("[data-mention-policy]").value,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    const payload = await readPayload(response);
    if (routeForApiError(response, payload)) return;
    if (!response.ok) throw new Error(payload.error || "Discord could not send this message.");

    messageInput.value = "";
    updateComposer();
    messageEmpty.hidden = true;
    messageList.hidden = false;
    if (!messageList.querySelector(`[data-message-id="${payload.message.id}"]`)) {
      messageList.append(createMessage(payload.message));
    }
    messageStream.scrollTop = messageStream.scrollHeight;
    const sentLabel = messageMode === "announcement" && payload.published ? "Announcement published." : "Message sent.";
    showToast(sentLabel);
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

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    messageMode = button.dataset.mode;
    document.querySelectorAll("[data-mode]").forEach((item) => item.classList.toggle("is-active", item === button));
    updateModeBanner();
  });
});

document.querySelectorAll("[data-token]").forEach((button) => {
  button.addEventListener("click", () => {
    const start = messageInput.selectionStart;
    const end = messageInput.selectionEnd;
    const needsSpace = start > 0 && !/\s/.test(messageInput.value[start - 1]);
    messageInput.setRangeText(`${needsSpace ? " " : ""}${button.dataset.token}`, start, end, "end");
    messageInput.focus();
    updateComposer();
  });
});

messageInput?.addEventListener("input", updateComposer);
messageInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendMessage();
  }
});
messageForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});
refreshButton?.addEventListener("click", () => loadMessages());
document.querySelector("[data-workspace-retry]")?.addEventListener("click", loadWorkspace);

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
  if (!document.hidden && selectedChannel && !sendInProgress) loadMessages({ quiet: true });
}, 10_000);

loadWorkspace();
updateComposer();
refreshIcons();

