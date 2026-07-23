const loadingView = document.querySelector("[data-dashboard-loading]");
const errorView = document.querySelector("[data-dashboard-error]");
const errorMessage = document.querySelector("[data-dashboard-error-message]");
const contentView = document.querySelector("[data-dashboard-content]");
const serverRows = document.querySelector("[data-server-rows]");
const serverTable = document.querySelector("[data-server-table]");
const serverEmpty = document.querySelector("[data-server-empty]");
const serverEmptyMessage = document.querySelector("[data-server-empty-message]");
const serverSearch = document.querySelector("[data-server-search]");
const refreshButton = document.querySelector("[data-refresh-dashboard]");
const testDialog = document.querySelector("[data-test-dialog]");
const testServerName = document.querySelector("[data-test-server-name]");
const confirmTestButton = document.querySelector("[data-confirm-test]");
const toast = document.querySelector("[data-dashboard-toast]");
const toastMessage = document.querySelector("[data-toast-message]");
const toastIcon = document.querySelector("[data-toast-icon]");

let dashboard = null;
let selectedGuildId = null;
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

function setLoading(isLoading) {
  loadingView.hidden = !isLoading || Boolean(dashboard);
  refreshButton.disabled = isLoading;
  refreshButton.classList.toggle("is-loading", isLoading);
}

function showError(message) {
  setLoading(false);
  contentView.hidden = true;
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
  if (
    payload.code === "SETUP_REQUIRED" ||
    payload.code === "BOT_SETUP_REQUIRED" ||
    payload.code === "BOT_TOKEN_INVALID" ||
    payload.code === "BOT_TOKEN_RECONNECT_REQUIRED"
  ) {
    leaveFor("/setup");
    return true;
  }
  return false;
}

function formatRelativeDate(value) {
  if (!value) return "Not tested";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not tested";
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function botInviteForGuild(guildId) {
  try {
    const invite = new URL(dashboard.bot.inviteUrl);
    invite.searchParams.set("guild_id", guildId);
    invite.searchParams.set("disable_guild_select", "true");
    return invite.toString();
  } catch {
    return dashboard.bot.inviteUrl || "https://discord.com/developers/applications";
  }
}

function createServerAvatar(guild) {
  const avatar = document.createElement("span");
  avatar.className = "server-avatar";
  if (guild.iconUrl) {
    const image = document.createElement("img");
    image.src = guild.iconUrl;
    image.alt = "";
    image.width = 42;
    image.height = 42;
    avatar.append(image);
  } else {
    avatar.textContent = (guild.name || "S").slice(0, 1).toUpperCase();
  }
  return avatar;
}

function createPermission(guild) {
  const badge = document.createElement("span");
  badge.className = `permission-badge${guild.administrator ? "" : " is-missing"}`;
  badge.append(icon(guild.administrator ? "shield-check" : "shield-alert"));
  badge.append(guild.administrator ? "Administrator" : "Permission missing");
  return badge;
}

function createStatus(guild) {
  const badge = document.createElement("span");
  if (guild.available) {
    badge.className = "status-badge is-available";
    badge.append(icon("circle-check"), "Available");
  } else if (guild.lastTestAt) {
    badge.className = "status-badge is-failed";
    badge.append(icon("circle-alert"), "Test failed");
  } else {
    badge.className = "status-badge";
    badge.append(icon("circle-dashed"), "Not tested");
  }
  return badge;
}

function createServerRow(guild) {
  const row = document.createElement("div");
  row.className = "server-row";
  row.dataset.guildId = guild.id;

  const identity = document.createElement("div");
  identity.className = "server-identity";
  const details = document.createElement("div");
  const name = document.createElement("strong");
  name.className = "server-name";
  name.textContent = guild.name;
  const id = document.createElement("span");
  id.className = "server-id";
  id.textContent = guild.id;
  details.append(name, id);
  identity.append(createServerAvatar(guild), details);

  const lastTest = document.createElement("div");
  lastTest.className = "server-last-test";
  const lastTestTime = document.createElement("strong");
  lastTestTime.textContent = formatRelativeDate(guild.lastTestAt);
  const channel = document.createElement("span");
  channel.textContent = guild.testChannel ? `#${guild.testChannel.name}` : "No channel selected";
  lastTest.append(lastTestTime, channel);

  const action = document.createElement("div");
  action.className = "server-actions";
  if (guild.administrator) {
    if (guild.available) {
      const open = document.createElement("a");
      open.className = "server-action is-open";
      open.href = `/server?guildId=${encodeURIComponent(guild.id)}`;
      open.append(icon("arrow-right"), "Open");
      open.addEventListener("click", (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        leaveFor(open.href);
      });
      action.append(open);

      const retest = document.createElement("button");
      retest.type = "button";
      retest.className = "server-action is-icon";
      retest.title = "Run connection test again";
      retest.setAttribute("aria-label", "Run connection test again");
      retest.append(icon("refresh-cw"));
      retest.addEventListener("click", () => openTestDialog(guild.id));
      action.append(retest);
    } else {
      const test = document.createElement("button");
      test.type = "button";
      test.className = "server-action";
      test.title = "Run connection test";
      test.append(icon("radio-tower"), "Test");
      test.addEventListener("click", () => openTestDialog(guild.id));
      action.append(test);
    }
  } else {
    const fix = document.createElement("a");
    fix.className = "server-action is-fix";
    fix.href = botInviteForGuild(guild.id);
    fix.target = "_blank";
    fix.rel = "noreferrer";
    fix.title = "Grant Administrator permission";
    fix.append(icon("wrench"), "Fix");
    action.append(fix);
  }

  row.append(identity, createPermission(guild), createStatus(guild), lastTest, action);
  return row;
}

function renderServers() {
  const query = serverSearch.value.trim().toLowerCase();
  const guilds = dashboard.guilds.filter((guild) => guild.name.toLowerCase().includes(query));
  serverRows.replaceChildren(...guilds.map(createServerRow));

  const noGuilds = dashboard.guilds.length === 0;
  const noMatches = !noGuilds && guilds.length === 0;
  serverTable.hidden = noGuilds || noMatches;
  serverEmpty.hidden = !(noGuilds || noMatches);
  serverEmptyMessage.textContent = noMatches
    ? "No connected server matches this search."
    : "Add the bot to a Discord server to continue.";
  document.querySelector("[data-empty-invite]").hidden = noMatches;
  refreshIcons();
}

function updateMetrics() {
  const guildCount = dashboard.guilds.length;
  const availableCount = dashboard.guilds.filter((guild) => guild.available).length;
  const attentionCount = guildCount - availableCount;
  document.querySelector("[data-metric-guilds]").textContent = String(guildCount);
  document.querySelector("[data-metric-available]").textContent = String(availableCount);
  document.querySelector("[data-metric-attention]").textContent = String(attentionCount);
}

function renderDashboard(payload) {
  dashboard = payload;
  errorView.hidden = true;
  contentView.hidden = false;
  setLoading(false);

  document.querySelector("[data-account-name]").textContent = payload.user.displayName;
  document.querySelector("[data-account-handle]").textContent = `@${payload.user.username}`;
  document.querySelector("[data-dashboard-account]").hidden = false;
  replaceAvatar(
    document.querySelector("[data-account-avatar]"),
    payload.user.avatarUrl,
    `${payload.user.displayName}'s Discord avatar`,
    "user"
  );

  document.querySelector("[data-sidebar-bot-name]").textContent = payload.bot.username;
  document.querySelector("[data-dashboard-bot-name]").textContent = payload.bot.username;
  replaceAvatar(document.querySelector("[data-sidebar-bot-avatar]"), payload.bot.avatarUrl, `${payload.bot.username} avatar`);
  replaceAvatar(document.querySelector("[data-dashboard-bot-avatar]"), payload.bot.avatarUrl, `${payload.bot.username} avatar`);
  document.querySelector("[data-last-sync]").textContent = formatRelativeDate(payload.syncedAt);
  document.querySelector("[data-empty-invite]").href = payload.bot.inviteUrl;

  updateMetrics();
  renderServers();
  refreshIcons();
}

async function loadDashboard() {
  errorView.hidden = true;
  setLoading(true);

  try {
    const response = await fetch("/api/dashboard", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const payload = await readPayload(response);
    if (routeForApiError(response, payload)) return;
    if (!response.ok) throw new Error(payload.error || "Valax could not scan Discord servers.");
    renderDashboard(payload);
  } catch (error) {
    showError(error instanceof Error ? error.message : "Valax could not load this workspace.");
  }
}

function openTestDialog(guildId) {
  const guild = dashboard.guilds.find((item) => item.id === guildId);
  if (!guild || !testDialog) return;
  selectedGuildId = guildId;
  testServerName.textContent = guild.name;
  testDialog.showModal();
}

function closeTestDialog() {
  if (testDialog?.open) testDialog.close();
  selectedGuildId = null;
}

function setTestBusy(isBusy) {
  confirmTestButton.disabled = isBusy;
  confirmTestButton.classList.toggle("is-loading", isBusy);
  confirmTestButton.replaceChildren(icon(isBusy ? "loader-circle" : "send"), isBusy ? "Testing Discord" : "Run test");
  refreshIcons();
}

async function runGuildTest() {
  if (!selectedGuildId) return;
  const guildId = selectedGuildId;
  setTestBusy(true);

  try {
    const response = await fetch("/api/dashboard/test", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ guildId }),
    });
    const payload = await readPayload(response);
    if (routeForApiError(response, payload)) return;
    if (!response.ok) throw new Error(payload.error || "The connection test failed.");

    const guild = dashboard.guilds.find((item) => item.id === guildId);
    if (guild) {
      guild.available = true;
      guild.lastTestAt = payload.guild.testedAt;
      guild.testChannel = payload.guild.testChannel;
      guild.lastError = null;
    }
    closeTestDialog();
    updateMetrics();
    renderServers();
    showToast(payload.guild.messageRemoved ? "Connection test passed." : "Connection passed; the test message could not be removed.");
  } catch (error) {
    closeTestDialog();
    showToast(error instanceof Error ? error.message : "The connection test failed.", true);
    await loadDashboard();
  } finally {
    setTestBusy(false);
  }
}

serverSearch?.addEventListener("input", renderServers);
refreshButton?.addEventListener("click", loadDashboard);
document.querySelector("[data-dashboard-retry]")?.addEventListener("click", loadDashboard);
document.querySelector("[data-confirm-test]")?.addEventListener("click", runGuildTest);
document.querySelector("[data-cancel-test]")?.addEventListener("click", closeTestDialog);
document.querySelector("[data-close-test-dialog]")?.addEventListener("click", closeTestDialog);
testDialog?.addEventListener("click", (event) => {
  if (event.target === testDialog) closeTestDialog();
});

document.querySelector("[data-dashboard-logout]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  } finally {
    leaveFor("/login");
  }
});

const menuButton = document.querySelector("[data-dashboard-menu]");
const menuScrim = document.querySelector("[data-dashboard-scrim]");
function setDashboardMenu(open) {
  document.body.classList.toggle("dashboard-nav-open", open);
  menuScrim.hidden = !open;
  const label = open ? "Close navigation" : "Open navigation";
  menuButton.setAttribute("aria-label", label);
  menuButton.setAttribute("title", label);
  menuButton.replaceChildren(icon(open ? "x" : "menu"));
  refreshIcons();
}
menuButton?.addEventListener("click", () => setDashboardMenu(!document.body.classList.contains("dashboard-nav-open")));
menuScrim?.addEventListener("click", () => setDashboardMenu(false));

loadDashboard();
refreshIcons();
