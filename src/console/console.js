// AgentCorp Human Approval & Coordination Console Logic
(function () {
  let adminToken = "";
  let sseAbortController = null;
  let sseReconnectTimer = null;
  let activeTab = "approvals";
  let activeRole = "";
  let selectedTaskId = null;
  let currentApprovals = [];
  let currentTasks = [];
  let currentMessages = [];
  let currentArtifacts = [];
  let currentPolicies = [];
  let pendingActionApprovalId = null;

  // Initialize
  document.addEventListener("DOMContentLoaded", () => {
    initAuth();
    setupNavigation();
    setupSearch();
    setupModals();
    setupButtons();
    loadAllData();
    connectSse();
  });

  function initAuth() {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token");
    if (urlToken) {
      adminToken = urlToken;
      try {
        sessionStorage.setItem("agentcorp_admin_token", urlToken);
      } catch {}
      // Remove sensitive token from URL to prevent leakage via browser history and Referer headers
      window.history.replaceState({}, document.title, window.location.pathname);
    } else {
      try {
        adminToken = sessionStorage.getItem("agentcorp_admin_token") || "";
      } catch {
        adminToken = "";
      }
    }
    updateAuthLabel();
  }

  function updateAuthLabel() {
    const label = document.getElementById("auth-status-label");
    if (label) {
      label.textContent = adminToken ? "Admin: Configured" : "Set Admin Token";
    }
  }

  function getHeaders() {
    return {
      "Content-Type": "application/json",
      ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
    };
  }

  // SSE Connection via Authenticated Fetch Stream (zero URL credentials)
  async function connectSse() {
    if (sseAbortController) {
      sseAbortController.abort();
      sseAbortController = null;
    }
    if (sseReconnectTimer) {
      clearTimeout(sseReconnectTimer);
      sseReconnectTimer = null;
    }

    const indicator = document.getElementById("sse-indicator");
    const statusText = document.getElementById("sse-status-text");

    if (!adminToken) {
      if (indicator) indicator.className = "status-dot disconnected";
      if (statusText) statusText.textContent = "Token Required";
      return;
    }

    sseAbortController = new AbortController();
    const signal = sseAbortController.signal;

    try {
      if (statusText) statusText.textContent = "Connecting...";
      const res = await fetch("/api/events", {
        headers: { Authorization: `Bearer ${adminToken}` },
        signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`SSE connection failed: HTTP ${res.status}`);
      }

      if (indicator) indicator.className = "status-dot connected";
      if (statusText) statusText.textContent = "Live SSE Connected";

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const block of parts) {
          if (!block.trim()) continue;
          let eventType = "message";
          let dataText = "";
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) {
              // Ignore keep-alive heartbeat comments
              continue;
            }
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataText = line.slice(5).trim();
            }
          }
          if (dataText) {
            try {
              const data = JSON.parse(dataText);
              handleBrokerEvent(data);
            } catch {}
          }
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      if (indicator) indicator.className = "status-dot disconnected";
      if (statusText) statusText.textContent = "Reconnecting...";
      sseReconnectTimer = setTimeout(connectSse, 3000);
    }
  }

  function handleBrokerEvent(event) {
    showToast(`Update: ${event.type.replace(/_/g, " ")}`);
    loadApprovals();
    if (activeTab === "tasks") loadTasks();
    if (activeTab === "inboxes") loadMessages();
    if (activeTab === "artifacts") loadArtifacts();
    if (activeTab === "policies") loadPolicies();
  }

  // Navigation
  function setupNavigation() {
    const navItems = document.querySelectorAll(".nav-item");
    navItems.forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-tab");
        if (!tab) return;
        switchTab(tab);
      });
    });
  }

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll(".nav-item").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-tab") === tab);
    });
    document.querySelectorAll(".tab-pane").forEach((pane) => {
      pane.classList.toggle("active", pane.id === `view-${tab}`);
    });

    if (tab === "approvals") loadApprovals();
    if (tab === "tasks") loadTasks();
    if (tab === "inboxes") loadMessages();
    if (tab === "artifacts") loadArtifacts();
    if (tab === "policies") loadPolicies();
  }

  // Data Loading
  async function loadAllData() {
    await loadHealth();
    await loadApprovals();
    await loadTasks();
    await loadMessages();
  }

  async function loadHealth() {
    try {
      const res = await fetch("/health");
      if (res.ok) {
        const data = await res.json();
        document.getElementById("company-name").textContent = data.company || "AgentCorp";
        setupRoleInboxPills(data.roles || [], data.presence || []);
        renderHeaderPresence(data.presence || []);
      }
    } catch {}
  }

  function renderHeaderPresence(presenceList) {
    const container = document.getElementById("header-presence-bar");
    if (!container) return;
    if (!presenceList || presenceList.length === 0) {
      container.innerHTML = "";
      return;
    }
    container.innerHTML = presenceList.map((p) => `
      <div class="presence-pill" title="Role: ${escapeHtml(p.roleId)}&#10;Agent: ${escapeHtml(p.boundAgent || 'unbound')}&#10;Last Seen: ${escapeHtml(p.lastSeenAt || 'never')}&#10;Status: ${p.status}">
        <span class="presence-dot ${p.status}"></span>
        <span>${escapeHtml(p.roleId)}</span>
      </div>
    `).join("");
  }

  async function loadApprovals() {
    if (!adminToken) return;
    try {
      const res = await fetch("/api/approvals", { headers: getHeaders() });
      if (res.ok) {
        currentApprovals = await res.json();
        renderApprovals(currentApprovals);
        const badge = document.getElementById("approvals-badge");
        if (badge) badge.textContent = currentApprovals.length;
      }
    } catch {}
  }

  async function loadTasks() {
    if (!adminToken) return;
    try {
      const res = await fetch("/api/tasks", { headers: getHeaders() });
      if (res.ok) {
        currentTasks = await res.json();
        renderTasks(currentTasks);
        const badge = document.getElementById("tasks-badge");
        if (badge) badge.textContent = currentTasks.length;
      }
    } catch {}
  }

  async function loadMessages() {
    if (!adminToken) return;
    try {
      const res = await fetch("/api/messages", { headers: getHeaders() });
      if (res.ok) {
        currentMessages = await res.json();
        renderInboxMessages();
        if (selectedTaskId) renderTaskThread(selectedTaskId);
      }
    } catch {}
  }

  async function loadArtifacts() {
    if (!adminToken) return;
    try {
      const res = await fetch("/api/artifacts", { headers: getHeaders() });
      if (res.ok) {
        currentArtifacts = await res.json();
        renderArtifacts(currentArtifacts);
      }
    } catch {}
  }

  async function loadPolicies() {
    if (!adminToken) return;
    try {
      const res = await fetch("/api/policies", { headers: getHeaders() });
      if (res.ok) {
        currentPolicies = await res.json();
        renderPolicies(currentPolicies);
      }
    } catch {}
  }

  // Render Approvals
  function renderApprovals(approvals) {
    const container = document.getElementById("approvals-container");
    if (!container) return;

    if (!approvals || approvals.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
          <h3>All clear! No pending approvals</h3>
          <p>Autonomous agent coordination is flowing or awaiting new tasks.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = approvals.map((app) => {
      const isMsg = app.subject === "message";
      const subjectBadge = isMsg
        ? '<span class="badge badge-cyan">Message</span>'
        : '<span class="badge badge-violet">Task Transition</span>';
      
      const payloadStr = app.context && typeof app.context === "object"
        ? JSON.stringify(app.context, null, 2)
        : String(app.context);

      return `
        <div class="card" data-id="${app.approvalId}">
          <div class="card-header">
            <div class="card-meta">
              ${subjectBadge}
              <span class="badge badge-amber">Pending Sign-off</span>
              <span style="font-size: 0.8rem; color: var(--text-muted);">${app.createdAt}</span>
            </div>
            <span style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-muted);">${app.approvalId}</span>
          </div>

          <div class="card-roles">
            <span style="color: var(--text-muted);">Requested By:</span>
            <span class="role-badge">${app.requestedBy}</span>
          </div>

          <div class="card-payload">${escapeHtml(payloadStr)}</div>

          <div class="card-actions">
            <button class="btn btn-secondary btn-sm edit-approve-btn" data-id="${app.approvalId}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
              </svg>
              <span>Edit & Approve</span>
            </button>
            <button class="btn btn-danger btn-sm reject-btn" data-id="${app.approvalId}">
              <span>Reject</span>
            </button>
            <button class="btn btn-primary btn-sm direct-approve-btn" data-id="${app.approvalId}">
              <span>Approve</span>
            </button>
          </div>
        </div>
      `;
    }).join("");

    // Attach listeners
    container.querySelectorAll(".direct-approve-btn").forEach((btn) => {
      btn.addEventListener("click", () => handleDirectApprove(btn.getAttribute("data-id")));
    });
    container.querySelectorAll(".edit-approve-btn").forEach((btn) => {
      btn.addEventListener("click", () => openDiffModal(btn.getAttribute("data-id")));
    });
    container.querySelectorAll(".reject-btn").forEach((btn) => {
      btn.addEventListener("click", () => openRejectModal(btn.getAttribute("data-id")));
    });
  }

  // Approvals Actions
  async function handleDirectApprove(approvalId) {
    if (!approvalId) return;
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ note: "Approved via Web Console" }),
      });
      if (res.ok) {
        showToast("Approval granted successfully", "success");
        loadApprovals();
      } else {
        const err = await res.json();
        showToast(`Approval failed: ${err.message || "Error"}`, "error");
      }
    } catch (e) {
      showToast(`Error: ${e.message}`, "error");
    }
  }

  function openDiffModal(approvalId) {
    pendingActionApprovalId = approvalId;
    const approval = currentApprovals.find((a) => a.approvalId === approvalId);
    if (!approval) return;

    const modal = document.getElementById("diff-modal");
    const origCode = document.getElementById("diff-original-code");
    const editor = document.getElementById("diff-editor-input");
    const badge = document.getElementById("diff-valid-badge");

    // Extract payload
    let payload = approval.context;
    if (approval.subject === "message") {
      const msg = currentMessages.find((m) => m.messageId === approval.subjectId);
      if (msg) payload = msg.payload;
    }

    const jsonStr = JSON.stringify(payload, null, 2);
    origCode.textContent = jsonStr;
    editor.value = jsonStr;
    badge.className = "badge badge-cyan";
    badge.textContent = "Valid JSON";

    editor.oninput = () => {
      try {
        JSON.parse(editor.value);
        badge.className = "badge badge-emerald";
        badge.textContent = "Valid JSON";
      } catch {
        badge.className = "badge badge-rose";
        badge.textContent = "Invalid JSON";
      }
    };

    modal.style.display = "flex";
  }

  function openRejectModal(approvalId) {
    pendingActionApprovalId = approvalId;
    document.getElementById("reject-note-input").value = "";
    document.getElementById("reject-modal").style.display = "flex";
  }

  // Tasks Render
  function renderTasks(tasks) {
    const container = document.getElementById("tasks-list-container");
    if (!container) return;

    if (!tasks || tasks.length === 0) {
      container.innerHTML = '<div class="empty-state">No tasks created yet.</div>';
      return;
    }

    container.innerHTML = tasks.map((task) => `
      <div class="task-card-item ${task.taskId === selectedTaskId ? "selected" : ""}" data-id="${task.taskId}">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <span style="font-weight: 600; font-size: 0.9rem;">${escapeHtml(task.title)}</span>
          <span class="badge ${getStatusBadgeClass(task.status)}">${task.status}</span>
        </div>
        <div style="font-size: 0.75rem; color: var(--text-muted); display: flex; gap: 8px;">
          <span>By: ${task.createdBy}</span>
          <span>→ ${task.assignedTo || "unassigned"}</span>
        </div>
      </div>
    `).join("");

    container.querySelectorAll(".task-card-item").forEach((card) => {
      card.addEventListener("click", () => {
        selectedTaskId = card.getAttribute("data-id");
        renderTasks(currentTasks);
        renderTaskThread(selectedTaskId);
      });
    });

    if (!selectedTaskId && tasks.length > 0) {
      selectedTaskId = tasks[0].taskId;
      renderTaskThread(selectedTaskId);
    }
  }

  function renderTaskThread(taskId) {
    const viewer = document.getElementById("thread-viewer-container");
    if (!viewer) return;

    const task = currentTasks.find((t) => t.taskId === taskId);
    if (!task) {
      viewer.innerHTML = '<div class="thread-empty">Select a task on the left.</div>';
      return;
    }

    const messages = currentMessages.filter((m) => m.taskId === taskId);

    const bubbles = messages.map((m) => `
      <div class="thread-bubble">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 0.75rem;">
          <div>
            <span class="role-badge">${m.fromRole}</span>
            <span style="color: var(--text-muted); margin: 0 4px;">→</span>
            <span class="role-badge">${m.toRole}</span>
          </div>
          <span class="badge ${getStatusBadgeClass(m.status)}">${m.status}</span>
        </div>
        <div style="font-family: var(--font-mono); font-size: 0.8rem; white-space: pre-wrap; color: #cbd5e1;">
          ${escapeHtml(typeof m.payload === "string" ? m.payload : JSON.stringify(m.payload, null, 2))}
        </div>
      </div>
    `).join("");

    viewer.innerHTML = `
      <div style="border-bottom: 1px solid var(--border-subtle); padding-bottom: 12px; margin-bottom: 14px;">
        <h2 style="font-size: 1.1rem; font-weight: 700;">${escapeHtml(task.title)}</h2>
        <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px;">${escapeHtml(task.description || "No description provided.")}</p>
      </div>
      ${bubbles.length > 0 ? bubbles : '<div class="thread-empty">No messages exchanged under this task yet.</div>'}
    `;
  }

  // Role Inboxes
  function setupRoleInboxPills(roles, presenceList = []) {
    const container = document.getElementById("role-inbox-pills");
    if (!container) return;
    if (roles.length > 0 && !activeRole) activeRole = roles[0];
    const presenceMap = new Map((presenceList || []).map((p) => [p.roleId, p]));

    container.innerHTML = roles.map((r) => {
      const pres = presenceMap.get(r);
      const status = pres ? pres.status : "offline";
      return `
        <button class="btn btn-sm ${r === activeRole ? "btn-primary" : "btn-secondary"}" data-role="${r}" style="display: inline-flex; align-items: center; gap: 6px;">
          <span class="presence-dot ${status}"></span>
          <span>${escapeHtml(r)}</span>
        </button>
      `;
    }).join("");

    container.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeRole = btn.getAttribute("data-role");
        setupRoleInboxPills(roles, presenceList);
        renderInboxMessages();
      });
    });
  }

  function renderInboxMessages() {
    const container = document.getElementById("inbox-messages-container");
    if (!container || !activeRole) return;

    const messages = currentMessages.filter((m) => m.toRole === activeRole && (m.status === "delivered" || m.status === "acknowledged"));

    if (messages.length === 0) {
      container.innerHTML = `<div class="empty-state">No delivered messages for role <strong>${activeRole}</strong>.</div>`;
      return;
    }

    container.innerHTML = messages.map((m) => `
      <div class="card">
        <div class="card-header">
          <div class="card-meta">
            <span class="role-badge">${m.fromRole}</span>
            <span style="font-size: 0.8rem; color: var(--text-muted);">${m.createdAt}</span>
          </div>
          <span class="badge ${getStatusBadgeClass(m.status)}">${m.status}</span>
        </div>
        <div class="card-payload">${escapeHtml(typeof m.payload === "string" ? m.payload : JSON.stringify(m.payload, null, 2))}</div>
      </div>
    `).join("");
  }

  // Artifacts
  function renderArtifacts(artifacts) {
    const tbody = document.getElementById("artifacts-table-body");
    if (!tbody) return;

    if (!artifacts || artifacts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center;">No artifacts created yet.</td></tr>';
      return;
    }

    tbody.innerHTML = artifacts.map((art) => `
      <tr>
        <td style="font-family: var(--font-mono);">${escapeHtml(art.artifactId)}</td>
        <td><strong>${escapeHtml(art.name)}</strong></td>
        <td><span class="badge badge-violet">${escapeHtml(art.type)}</span></td>
        <td><span class="role-badge">${escapeHtml(art.producedBy)}</span></td>
        <td>${escapeHtml(Array.isArray(art.visibleToRoles) ? art.visibleToRoles.join(", ") : art.visibleToRoles)}</td>
        <td style="font-family: var(--font-mono); font-size: 0.75rem;">${escapeHtml(art.contentHash.slice(0, 10))}...</td>
        <td>
          <button class="btn btn-ghost btn-sm view-art-btn" data-id="${escapeHtml(art.artifactId)}">View</button>
        </td>
      </tr>
    `).join("");

    tbody.querySelectorAll(".view-art-btn").forEach((btn) => {
      btn.addEventListener("click", () => showArtifactDetails(btn.getAttribute("data-id")));
    });
  }

  async function showArtifactDetails(artifactId) {
    try {
      const res = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}`, { headers: getHeaders() });
      if (res.ok) {
        const art = await res.json();
        alert(`Artifact: ${art.name}\n\nContent:\n${art.content || art.contentUri}`);
      }
    } catch {}
  }

  // Policies
  function renderPolicies(policies) {
    const container = document.getElementById("policies-container");
    if (!container) return;

    if (!policies || policies.length === 0) {
      container.innerHTML = '<div class="empty-state">No policy rules registered.</div>';
      return;
    }

    container.innerHTML = policies.map((p) => `
      <div class="card">
        <div class="card-header">
          <div class="card-meta">
            <span class="badge badge-violet">Priority: ${p.priority}</span>
            <span class="badge ${p.action === "auto_approve" ? "badge-emerald" : "badge-amber"}">${escapeHtml(p.action)}</span>
          </div>
          <button class="btn btn-sm ${p.enabled ? "btn-secondary" : "btn-danger"} toggle-policy-btn" data-id="${escapeHtml(p.id)}" data-enabled="${p.enabled}">
            ${p.enabled ? "Enabled" : "Disabled"}
          </button>
        </div>
        <h3 style="font-size: 0.95rem; margin-bottom: 6px;">Rule: ${escapeHtml(p.id)}</h3>
        <p style="font-size: 0.8rem; color: var(--text-muted);">Subject: ${escapeHtml(p.subject)} ${p.message_type ? `(${escapeHtml(p.message_type)})` : ""}</p>
        ${p.risk_tags ? `<div style="margin-top: 8px; display: flex; gap: 6px;">${p.risk_tags.map((t) => `<span class="badge badge-cyan">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      </div>
    `).join("");

    container.querySelectorAll(".toggle-policy-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-id");
        const enabled = btn.getAttribute("data-enabled") === "true";
        await togglePolicy(id, !enabled);
      });
    });
  }

  async function togglePolicy(policyId, enabled) {
    try {
      const res = await fetch(`/api/policies/${encodeURIComponent(policyId)}/${enabled ? "enable" : "disable"}`, {
        method: "POST",
        headers: getHeaders(),
      });
      if (res.ok) {
        showToast(`Policy ${policyId} ${enabled ? "enabled" : "disabled"}`, "success");
        loadPolicies();
      }
    } catch {}
  }

  // Modals & Button Listeners
  function setupModals() {
    // Diff Modal
    const diffModal = document.getElementById("diff-modal");
    document.getElementById("diff-modal-close")?.addEventListener("click", () => (diffModal.style.display = "none"));
    document.getElementById("diff-cancel-btn")?.addEventListener("click", () => (diffModal.style.display = "none"));

    document.getElementById("diff-submit-approve-btn")?.addEventListener("click", async () => {
      if (!pendingActionApprovalId) return;
      const editor = document.getElementById("diff-editor-input");
      const noteInput = document.getElementById("diff-decision-note");
      try {
        const revisedPayload = JSON.parse(editor.value);
        const res = await fetch(`/api/approvals/${encodeURIComponent(pendingActionApprovalId)}/approve`, {
          method: "POST",
          headers: getHeaders(),
          body: JSON.stringify({
            note: noteInput.value || "Approved with human modification via Web Console",
            payload: revisedPayload,
          }),
        });
        if (res.ok) {
          showToast("Approved with payload modification", "success");
          diffModal.style.display = "none";
          loadApprovals();
        } else {
          showToast("Failed to submit approval", "error");
        }
      } catch (e) {
        showToast("Invalid JSON in editor", "error");
      }
    });

    // Reject Modal
    const rejectModal = document.getElementById("reject-modal");
    document.getElementById("reject-modal-close")?.addEventListener("click", () => (rejectModal.style.display = "none"));
    document.getElementById("reject-cancel-btn")?.addEventListener("click", () => (rejectModal.style.display = "none"));

    document.getElementById("reject-confirm-btn")?.addEventListener("click", async () => {
      if (!pendingActionApprovalId) return;
      const note = document.getElementById("reject-note-input").value;
      try {
        const res = await fetch(`/api/approvals/${encodeURIComponent(pendingActionApprovalId)}/reject`, {
          method: "POST",
          headers: getHeaders(),
          body: JSON.stringify({ note: note || "Rejected by human operator" }),
        });
        if (res.ok) {
          showToast("Approval rejected", "success");
          rejectModal.style.display = "none";
          loadApprovals();
        }
      } catch {}
    });

    // Auth Modal
    const authModal = document.getElementById("auth-modal");
    document.getElementById("auth-modal-btn")?.addEventListener("click", () => {
      document.getElementById("admin-token-input").value = adminToken;
      authModal.style.display = "flex";
    });
    document.getElementById("auth-modal-close")?.addEventListener("click", () => (authModal.style.display = "none"));
    document.getElementById("auth-cancel-btn")?.addEventListener("click", () => (authModal.style.display = "none"));
    document.getElementById("auth-save-btn")?.addEventListener("click", () => {
      adminToken = document.getElementById("admin-token-input").value.trim();
      try {
        sessionStorage.setItem("agentcorp_admin_token", adminToken);
      } catch {}
      updateAuthLabel();
      authModal.style.display = "none";
      loadAllData();
      connectSse();
      showToast("Token updated", "success");
    });
  }

  function setupButtons() {
    document.getElementById("refresh-approvals-btn")?.addEventListener("click", () => loadApprovals());

    document.getElementById("export-audit-btn")?.addEventListener("click", async () => {
      try {
        const res = await fetch("/api/audit/export", {
          method: "POST",
          headers: getHeaders(),
          body: JSON.stringify({ outputDir: "coord" }),
        });
        if (res.ok) {
          showToast("Audit export written to /coord", "success");
        } else {
          showToast("Audit export failed", "error");
        }
      } catch (e) {
        showToast(`Error: ${e.message}`, "error");
      }
    });
  }

  // Search Filter
  function setupSearch() {
    const input = document.getElementById("search-input");
    if (!input) return;

    window.addEventListener("keydown", (e) => {
      if (e.key === "/" && document.activeElement !== input) {
        e.preventDefault();
        input.focus();
      }
    });

    input.addEventListener("input", () => {
      const q = input.value.toLowerCase().trim();
      if (!q) {
        renderApprovals(currentApprovals);
        renderTasks(currentTasks);
        return;
      }

      if (activeTab === "approvals") {
        const filtered = currentApprovals.filter((a) =>
          a.approvalId.toLowerCase().includes(q) ||
          a.requestedBy.toLowerCase().includes(q) ||
          JSON.stringify(a.context).toLowerCase().includes(q)
        );
        renderApprovals(filtered);
      } else if (activeTab === "tasks") {
        const filtered = currentTasks.filter((t) =>
          t.title.toLowerCase().includes(q) ||
          t.status.toLowerCase().includes(q) ||
          t.createdBy.toLowerCase().includes(q)
        );
        renderTasks(filtered);
      }
    });
  }

  // Helpers
  function getStatusBadgeClass(status) {
    switch (status) {
      case "approved":
      case "delivered":
      case "completed": return "badge-emerald";
      case "pending":
      case "pending_approval":
      case "awaiting_review": return "badge-amber";
      case "rejected":
      case "failed": return "badge-rose";
      case "in_progress": return "badge-cyan";
      default: return "badge-violet";
    }
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function showToast(message, type = "info") {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transition = "opacity 0.3s ease";
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }
})();
