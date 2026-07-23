const loadingView = document.querySelector("[data-setup-loading]");
const panels = [...document.querySelectorAll("[data-step-panel]")];
const progressItems = [...document.querySelectorAll("[data-progress]")];
const account = document.querySelector("[data-setup-account]");
const accountAvatar = document.querySelector("[data-setup-avatar]");
const accountName = document.querySelector("[data-setup-name]");
const membershipNotice = document.querySelector("[data-membership-notice]");
const botForm = document.querySelector("[data-bot-form]");
const tokenInput = document.querySelector("#bot-token");
const tokenToggle = document.querySelector("[data-toggle-token]");
const verifyButton = document.querySelector("[data-verify-button]");
const botError = document.querySelector("[data-bot-error]");
const botErrorMessage = document.querySelector("[data-bot-error-message]");
const results = document.querySelector("[data-verification-results]");
const guildResults = document.querySelector("[data-guild-results]");
const resultActions = document.querySelector("[data-result-actions]");
const resultGuidance = document.querySelector("[data-result-guidance]");
const botInvite = document.querySelector("[data-bot-invite]");

let currentConnection = null;

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
    return;
  }

  container.replaceChildren(icon(fallbackIcon));
}

function leaveFor(destination) {
  document.body.classList.remove("page-enter", "page-ready");
  document.body.classList.add("is-leaving");
  window.setTimeout(() => window.location.replace(destination), 460);
}

function showPanel(step) {
  loadingView.hidden = true;
  panels.forEach((panel) => {
    panel.hidden = panel.dataset.stepPanel !== step;
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setProgress(currentStep, connection = currentConnection) {
  const communityComplete = currentStep !== "community";
  const botComplete = connection?.ready === true;

  progressItems.forEach((item) => {
    const step = item.dataset.progress;
    const complete =
      step === "account" ||
      (step === "community" && communityComplete) ||
      (step === "bot" && botComplete) ||
      (step === "complete" && currentStep === "complete");

    item.classList.toggle("is-current", step === currentStep);
    item.classList.toggle("is-complete", complete);

    const marker = item.firstElementChild;
    if (complete && marker) marker.replaceChildren(icon("check"));
  });
  refreshIcons();
}

function renderAccount(user) {
  if (!user || !account) return;
  account.hidden = false;
  accountName.textContent = user.displayName || user.username || "Discord user";
  replaceAvatar(accountAvatar, user.avatarUrl, `${accountName.textContent}'s Discord avatar`, "user");
}

function setDiagnostic(row, passed, passLabel = "Enabled", failLabel = "Missing") {
  if (!row) return;
  row.classList.toggle("is-pass", passed);
  row.classList.toggle("is-fail", !passed);
  const value = row.querySelector("strong");
  if (value) value.textContent = passed ? passLabel : failLabel;
}

function guildIconUrl(guild) {
  if (!guild.icon) return null;
  const extension = guild.icon.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${extension}?size=64`;
}

function renderGuilds(guilds) {
  guildResults.replaceChildren();

  if (!guilds.length) {
    const empty = document.createElement("p");
    empty.className = "empty-guilds";
    empty.textContent = "This bot is not connected to a Discord server yet.";
    guildResults.append(empty);
    return;
  }

  guilds.forEach((guild) => {
    const row = document.createElement("div");
    row.className = "guild-row";

    const avatar = document.createElement("span");
    avatar.className = "guild-row-avatar";
    const imageUrl = guildIconUrl(guild);
    if (imageUrl) {
      const image = document.createElement("img");
      image.src = imageUrl;
      image.alt = "";
      image.width = 30;
      image.height = 30;
      avatar.append(image);
    } else {
      avatar.textContent = (guild.name || "S").slice(0, 1).toUpperCase();
    }

    const name = document.createElement("strong");
    name.textContent = guild.name || "Discord server";

    const permission = document.createElement("span");
    permission.classList.toggle("is-missing", !guild.administrator);
    permission.append(icon(guild.administrator ? "shield-check" : "shield-alert"));
    permission.append(guild.administrator ? "Administrator" : "Permission missing");

    row.append(avatar, name, permission);
    guildResults.append(row);
  });
}

function renderConnection(connection) {
  if (!connection?.configured) return;
  currentConnection = connection;

  const guilds = Array.isArray(connection.guilds) ? connection.guilds : [];
  const intents = connection.intents || {};
  const hasServer = guilds.length > 0;
  const hasAdministrator = guilds.some((guild) => guild.administrator);

  document.querySelector("[data-bot-name]").textContent = connection.bot?.username || "Discord bot";
  replaceAvatar(
    document.querySelector("[data-bot-avatar]"),
    connection.bot?.avatarUrl,
    `${connection.bot?.username || "Discord bot"} avatar`
  );

  setDiagnostic(document.querySelector('[data-intent="presence"]'), intents.presence === true);
  setDiagnostic(document.querySelector('[data-intent="members"]'), intents.members === true);
  setDiagnostic(document.querySelector('[data-intent="messageContent"]'), intents.messageContent === true);
  setDiagnostic(document.querySelector('[data-diagnostic="server"]'), hasServer, `${guilds.length} found`, "Not connected");
  setDiagnostic(
    document.querySelector('[data-diagnostic="administrator"]'),
    hasAdministrator,
    "Verified",
    "Missing"
  );

  renderGuilds(guilds);
  results.hidden = false;
  resultActions.hidden = connection.ready === true;
  botInvite.hidden = !connection.inviteUrl || (hasServer && hasAdministrator);
  if (connection.inviteUrl) botInvite.href = connection.inviteUrl;

  const missingIntents = Object.values(intents).some((enabled) => enabled !== true);
  if (missingIntents) {
    resultGuidance.textContent = "Enable every privileged intent in the Developer Portal, then recheck the bot.";
  } else if (!hasServer) {
    resultGuidance.textContent = "Add the bot to a server with Administrator permission, then recheck it.";
  } else if (!hasAdministrator) {
    resultGuidance.textContent = "Grant Administrator permission in Discord, then recheck the bot.";
  }

  refreshIcons();
}

function renderComplete(connection) {
  currentConnection = connection;
  const guilds = Array.isArray(connection?.guilds) ? connection.guilds : [];
  document.querySelector("[data-complete-bot]").textContent = connection?.bot?.username || "Discord bot";
  document.querySelector("[data-complete-guilds]").textContent = String(guilds.length);
  replaceAvatar(
    document.querySelector("[data-complete-avatar]"),
    connection?.bot?.avatarUrl,
    `${connection?.bot?.username || "Discord bot"} avatar`
  );
  setProgress("complete", connection);
  showPanel("complete");
  refreshIcons();
}

function showBotError(message) {
  botErrorMessage.textContent = message || "Discord could not verify this bot right now.";
  botError.hidden = false;
}

function setVerifyBusy(isBusy, label = "Verify and connect") {
  verifyButton.disabled = isBusy;
  verifyButton.replaceChildren(icon(isBusy ? "loader-circle" : "scan-search"), label);
  verifyButton.classList.toggle("is-loading", isBusy);
  refreshIcons();
}

async function readPayload(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function loadStatus() {
  try {
    const response = await fetch("/api/onboarding/status", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const payload = await readPayload(response);

    if (response.status === 401) {
      leaveFor("/login?returnTo=%2Fsetup");
      return;
    }
    if (!response.ok) throw new Error(payload.error || "Valax could not load your setup status.");

    renderAccount(payload.user);
    currentConnection = payload.botConnection;
    membershipNotice.hidden = !(payload.currentStep === "community" && new URLSearchParams(location.search).has("checked"));

    if (payload.currentStep === "community") {
      setProgress("community");
      showPanel("community");
    } else if (payload.currentStep === "complete" && payload.botConnection) {
      renderComplete(payload.botConnection);
    } else {
      setProgress("bot", payload.botConnection);
      showPanel("bot");
      if (payload.botConnection) renderConnection(payload.botConnection);
    }
  } catch (error) {
    loadingView.querySelector("strong").textContent = "Setup is temporarily unavailable";
    loadingView.querySelector("span:not(.setup-spinner)").textContent =
      error instanceof Error ? error.message : "Please refresh and try again.";
  }
}

async function verifyBot(token) {
  botError.hidden = true;
  setVerifyBusy(true, token ? "Verifying with Discord" : "Rechecking bot");

  try {
    const request = fetch("/api/onboarding/bot", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(token ? { token } : {}),
    });
    tokenInput.value = "";
    tokenInput.type = "password";
    tokenToggle.setAttribute("aria-label", "Show token");
    tokenToggle.setAttribute("title", "Show token");
    tokenToggle.replaceChildren(icon("eye"));

    const response = await request;
    const payload = await readPayload(response);

    if (response.status === 401 && payload.code === "AUTH_REQUIRED") {
      leaveFor("/login?returnTo=%2Fsetup");
      return;
    }
    if (response.status === 403 && payload.code === "MEMBERSHIP_REQUIRED") {
      await loadStatus();
      return;
    }
    if (!response.ok) throw new Error(payload.error || "Discord could not verify this bot right now.");

    renderConnection(payload.connection);
    if (payload.connection?.ready) {
      window.setTimeout(() => renderComplete(payload.connection), 650);
    } else {
      setProgress("bot", payload.connection);
      results.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (error) {
    showBotError(error instanceof Error ? error.message : "Discord could not verify this bot right now.");
  } finally {
    setVerifyBusy(false);
  }
}

tokenToggle?.addEventListener("click", () => {
  const showToken = tokenInput.type === "password";
  tokenInput.type = showToken ? "text" : "password";
  const label = showToken ? "Hide token" : "Show token";
  tokenToggle.setAttribute("aria-label", label);
  tokenToggle.setAttribute("title", label);
  tokenToggle.replaceChildren(icon(showToken ? "eye-off" : "eye"));
  refreshIcons();
  tokenInput.focus();
});

botForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) {
    showBotError("Enter the Bot Token generated in the Discord Developer Portal.");
    tokenInput.focus();
    return;
  }
  verifyBot(token);
});

document.querySelector("[data-recheck-bot]")?.addEventListener("click", () => verifyBot(""));
document.querySelector("[data-review-connection]")?.addEventListener("click", () => {
  setProgress("bot", currentConnection);
  showPanel("bot");
  if (currentConnection) renderConnection(currentConnection);
});

loadStatus();
refreshIcons();
