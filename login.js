const loadingView = document.querySelector("[data-auth-loading]");
const guestView = document.querySelector("[data-auth-guest]");
const userView = document.querySelector("[data-auth-user]");
const errorView = document.querySelector("[data-auth-error]");
const errorMessage = document.querySelector("[data-error-message]");
const toast = document.querySelector("[data-toast]");

const views = [loadingView, guestView, userView, errorView];

function showView(target) {
  views.forEach((view) => {
    if (view) view.hidden = view !== target;
  });
}

function showError(message) {
  if (errorMessage) errorMessage.textContent = message;
  showView(errorView);
}

function renderUser(user) {
  document.querySelector("[data-user-name]").textContent = user.displayName;
  document.querySelector("[data-user-handle]").textContent = `@${user.username}`;
  document.querySelector("[data-guild-count]").textContent = String(user.guildCount || 0);

  const avatar = document.querySelector("[data-user-avatar]");
  if (user.avatarUrl) {
    const image = document.createElement("img");
    image.src = user.avatarUrl;
    image.alt = `${user.displayName}'s Discord avatar`;
    image.width = 64;
    image.height = 64;
    avatar.replaceChildren(image);
  }

  showView(userView);
}

async function loadSession() {
  showView(loadingView);

  try {
    const response = await fetch("/api/session", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const payload = await response.json();

    if (!response.ok) throw new Error(payload.error || "Authentication service unavailable.");
    if (payload.authenticated) {
      renderUser(payload.user);
    } else {
      showView(guestView);
    }
  } catch (error) {
    showError(error instanceof Error ? error.message : "Authentication service unavailable.");
  }
}

document.querySelector("[data-logout]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.innerHTML = '<span class="auth-spinner auth-spinner-small" aria-hidden="true"></span> Signing out';

  try {
    const response = await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    if (!response.ok) throw new Error("Sign out failed.");
    window.location.replace("/login");
  } catch {
    button.disabled = false;
    button.innerHTML = '<i data-lucide="log-out" aria-hidden="true"></i> Sign out';
    window.lucide?.createIcons();
  }
});

document.querySelector("[data-retry]")?.addEventListener("click", loadSession);

const legalContent = {
  privacy: {
    title: "Privacy Notice",
    sections: [
      ["What Valax stores", "Your Discord user ID, username, display name, avatar reference, server count, and session records needed to keep you signed in."],
      ["What Valax never receives", "Discord handles your password and authentication. Valax never receives or stores your Discord password."],
      ["Session security", "The browser receives a random HttpOnly session cookie. OAuth access tokens are used during sign-in and are not stored by this login flow."],
      ["Your control", "Signing out removes the active Valax session. Account deletion and export controls will be available in account settings."],
    ],
  },
  rules: {
    title: "Community Rules",
    sections: [
      ["Use Valax responsibly", "Only send messages to communities and members you are authorized to manage. Do not use Valax for spam, harassment, or deceptive communication."],
      ["Respect Discord", "Your use of Valax must follow Discord's Terms of Service, Community Guidelines, and API policies."],
      ["Protect credentials", "Never share bot tokens, OAuth secrets, or account access. Report suspected credential exposure immediately."],
      ["Keep people in control", "Review recipients and content before sending announcements or direct messages."],
    ],
  },
};

const legalDialog = document.querySelector("[data-legal-dialog]");
const dialogTitle = document.querySelector("[data-dialog-title]");
const dialogBody = document.querySelector("[data-dialog-body]");

document.querySelectorAll("[data-legal]").forEach((button) => {
  button.addEventListener("click", () => {
    const content = legalContent[button.dataset.legal];
    if (!content || !legalDialog) return;

    dialogTitle.textContent = content.title;
    dialogBody.replaceChildren(
      ...content.sections.map(([title, body]) => {
        const section = document.createElement("section");
        const heading = document.createElement("h3");
        const paragraph = document.createElement("p");
        heading.textContent = title;
        paragraph.textContent = body;
        section.append(heading, paragraph);
        return section;
      })
    );
    legalDialog.showModal();
  });
});

document.querySelector("[data-close-dialog]")?.addEventListener("click", () => legalDialog?.close());
legalDialog?.addEventListener("click", (event) => {
  if (event.target === legalDialog) legalDialog.close();
});

const params = new URLSearchParams(window.location.search);
const oauthError = params.get("error");
if (oauthError) {
  const messages = {
    access_denied: "Discord authorization was cancelled.",
    invalid_state: "The sign-in request expired. Please start again.",
    database_unavailable: "Valax could not reach its database. Please try again after the service configuration is updated.",
    oauth_failed: "Discord sign-in could not be completed. Please try again.",
  };
  showError(messages[oauthError] || "Discord sign-in could not be completed.");
} else {
  loadSession();
}

if (params.get("status") === "success" && toast) {
  toast.hidden = false;
  window.setTimeout(() => {
    toast.classList.add("is-hiding");
    window.setTimeout(() => { toast.hidden = true; }, 250);
  }, 3200);
  window.history.replaceState({}, "", "/login");
}

window.lucide?.createIcons();
