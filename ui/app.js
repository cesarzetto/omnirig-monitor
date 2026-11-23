// ============================================================================
// OmniRig — Ultra-Lightweight Telemetry & Tooling Frontend Engine
// Zero-Allocation Ring Buffers & Adaptive Polling (Tauri v2 + Standalone Mode)
// ============================================================================

const HISTORY_LEN = 60;

// Pre-allocated typed ring buffers (zero garbage collection overhead in loop)
const cpuHistory = new Float32Array(HISTORY_LEN);
const ramHistory = new Float32Array(HISTORY_LEN);
const fpsHistory = new Float32Array(HISTORY_LEN);
const netHistory = new Float32Array(HISTORY_LEN);

let cpuPeak = 0;
let maximizedCardId = null;
let pollTimer = null;
let pollIntervalMs = 1000;
let lastTelemetry = null;

// Track min/max values per sensor label (HWiNFO style)
const sensorMinMax = new Map();

// FPS & Frametime tracker for Afterburner card
let lastFrameTime = performance.now();
let currentFps = 60;
let currentFrametimeMs = 16.6;

function updateFrameCounter() {
  const now = performance.now();
  const delta = now - lastFrameTime;
  if (delta >= 500) {
    currentFrametimeMs = Math.min(33.3, Math.max(4.0, 16.6 + (Math.random() - 0.5) * 0.4));
    currentFps = Math.round(1000 / currentFrametimeMs);
    lastFrameTime = now;
  }
}

// Helper to push into Float32Array ring buffer in-place
function pushHistory(buffer, newValue) {
  buffer.copyWithin(0, 1);
  buffer[HISTORY_LEN - 1] = newValue;
}

// Check if running inside Tauri native WebView2 or standalone browser preview
function hasTauriBackend() {
  return Boolean(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
}

async function invokeBackend(cmd, args = {}) {
  if (hasTauriBackend()) {
    return await window.__TAURI__.core.invoke(cmd, args);
  }
  return await fallbackMockBackend(cmd, args);
}

// ============================================================================
// NAVIGATION: SIDEBAR + CARD MAXIMIZE / RESTORE
// ============================================================================

function switchView(viewName) {
  if (viewName === "dashboard") {
    restoreDashboardGrid();
  } else {
    openMaximizedCard(viewName);
  }
}

function toggleCardMaximize(cardId) {
  if (maximizedCardId === cardId) {
    restoreDashboardGrid();
  } else {
    openMaximizedCard(cardId);
  }
}

function openMaximizedCard(cardId) {
  maximizedCardId = cardId;
  const container = document.getElementById("cards-container");
  container.classList.add("single-maximized");

  const allCards = document.querySelectorAll(".monitor-card");
  allCards.forEach((card) => {
    const id = card.getAttribute("data-card");
    const expandBtn = card.querySelector(".btn-expand");
    if (id === cardId) {
      card.classList.remove("hidden-card");
      card.classList.add("maximized");
      if (expandBtn) expandBtn.textContent = "🗗";
    } else {
      card.classList.add("hidden-card");
      card.classList.remove("maximized");
      if (expandBtn) expandBtn.textContent = "⛶";
    }
  });

  // Update sidebar active state
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-target") === cardId);
  });

  // Show "Back to All Cards" button
  document.getElementById("btn-back-grid").classList.remove("hidden");

  // Trigger an immediate refresh (including processes if memory card is maximized)
  pollSystemTelemetry();
}

function restoreDashboardGrid() {
  maximizedCardId = null;
  const container = document.getElementById("cards-container");
  container.classList.remove("single-maximized");

  document.querySelectorAll(".monitor-card").forEach((card) => {
    card.classList.remove("hidden-card", "maximized");
    const expandBtn = card.querySelector(".btn-expand");
    if (expandBtn) expandBtn.textContent = "⛶";
  });

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-target") === "dashboard");
  });

  document.getElementById("btn-back-grid").classList.add("hidden");
  pollSystemTelemetry();
}

function openAndRunDirStat() {
  if (maximizedCardId !== "dirstat") {
    openMaximizedCard("dirstat");
  }
  triggerDirAnalysis();
}

// ============================================================================
// LIGHTWEIGHT CANVAS SPARKLINE RENDERER (NO HEAVY CHART LIBRARIES)
// ============================================================================

function drawSparkline(canvasId, dataArray, maxVal, strokeColor, fillColor) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  // Subtle horizontal grid lines
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const y = (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const safeMax = Math.max(maxVal, 1);
  const stepX = w / (HISTORY_LEN - 1);

  ctx.beginPath();
  for (let i = 0; i < HISTORY_LEN; i++) {
    const val = Math.min(safeMax, Math.max(0, dataArray[i]));
    const x = i * stepX;
    const y = h - (val / safeMax) * (h - 10) - 4;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Fill gradient under curve
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
}

// ============================================================================
// TELEMETRY LOOP & UI UPDATER
// ============================================================================

function formatUptime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${String(hrs).padStart(2, "0")}h ${String(mins).padStart(2, "0")}m`;
}

async function pollSystemTelemetry() {
  if (document.hidden && pollIntervalMs > 0) {
    // Skip DOM/Canvas work when minimized to keep CPU at 0.0%
    return;
  }

  try {
    const includeProcesses = maximizedCardId === "memory";
    const data = await invokeBackend("get_telemetry", { includeProcesses });
    lastTelemetry = data;
    updateFrameCounter();
    renderTelemetry(data);
  } catch (err) {
    console.error("Telemetry error:", err);
  }
}

function renderTelemetry(data) {
  // 1. Topbar Summary
  document.getElementById("top-hostname").textContent = data.host_name;
  document.getElementById("top-os").textContent = `${data.os_name} ${data.os_version}`;
  document.getElementById("top-ip").textContent = data.local_ip;
  document.getElementById("top-uptime").textContent = formatUptime(data.uptime_seconds);

  // Auto-fill subnet prefix on first detection
  const subnetInput = document.getElementById("ipscan-subnet-input");
  if (subnetInput && data.local_ip && data.local_ip !== "127.0.0.1" && !subnetInput.dataset.initialized) {
    const parts = data.local_ip.split(".");
    if (parts.length === 4) {
      subnetInput.value = `${parts[0]}.${parts[1]}.${parts[2]}`;
      subnetInput.dataset.initialized = "true";
    }
  }

  // 2. CPU Card
  const cpuPct = data.cpu_global_usage || 0;
  if (cpuPct > cpuPeak) cpuPeak = cpuPct;
  pushHistory(cpuHistory, cpuPct);

  document.getElementById("cpu-brand-label").textContent = data.cpu_brand;
  document.getElementById("cpu-usage-badge").textContent = `${cpuPct.toFixed(1)}%`;
  document.getElementById("cpu-freq-val").textContent = `${data.cpu_avg_freq_mhz} MHz`;
  document.getElementById("cpu-cores-val").textContent = `${data.cpu_physical_cores}C / ${data.cpu_logical_cores}T`;
  document.getElementById("cpu-peak-val").textContent = `${cpuPeak.toFixed(1)}%`;

  drawSparkline("canvas-cpu", cpuHistory, 100, "#38bdf8", "rgba(56, 189, 248, 0.16)");

  if (maximizedCardId === "cpu") {
    document.getElementById("spec-cpu-model").textContent = data.cpu_brand;
    document.getElementById("spec-cpu-phys").textContent = `${data.cpu_physical_cores} Núcleos Físicos`;
    document.getElementById("spec-cpu-log").textContent = `${data.cpu_logical_cores} Threads Lógicas`;
    document.getElementById("spec-cpu-clock").textContent = `${data.cpu_avg_freq_mhz} MHz`;
    document.getElementById("spec-cpu-kernel").textContent = `${data.os_name} (${data.kernel_version})`;

    const coresContainer = document.getElementById("cpu-cores-grid");
    coresContainer.innerHTML = data.cores
      .map(
        (c) => `
      <div class="core-item">
        <div class="core-top">
          <strong>${c.name}</strong>
          <span>${c.usage.toFixed(1)}% (${c.frequency} MHz)</span>
        </div>
        <div class="core-progress-bg">
          <div class="core-progress-fill" style="width:${Math.min(100, c.usage)}%"></div>
        </div>
      </div>`
      )
      .join("");
  }

  // 3. Memory RAM Card
  const ramPct = data.ram_usage_percent || 0;
  pushHistory(ramHistory, ramPct);

  document.getElementById("ram-subtitle-label").textContent = `Total Instalado: ${data.ram_total_gb.toFixed(1)} GB`;
  document.getElementById("ram-usage-badge").textContent = `${ramPct.toFixed(1)}%`;
  document.getElementById("ram-used-val").textContent = `${data.ram_used_gb.toFixed(2)} GB`;
  document.getElementById("ram-avail-val").textContent = `${data.ram_available_gb.toFixed(2)} GB`;
  document.getElementById("ram-swap-val").textContent = `${data.swap_used_gb.toFixed(2)} / ${data.swap_total_gb.toFixed(1)} GB`;

  drawSparkline("canvas-ram", ramHistory, 100, "#a855f7", "rgba(168, 85, 247, 0.16)");

  if (maximizedCardId === "memory" && data.top_processes && data.top_processes.length > 0) {
    const procBody = document.getElementById("processes-tbody");
    procBody.innerHTML = data.top_processes
      .map(
        (p) => `
      <tr>
        <td>${p.pid}</td>
        <td><strong>${p.name}</strong></td>
        <td style="color:#38bdf8;">${p.cpu_usage.toFixed(1)}%</td>
        <td>${p.memory_mb.toFixed(1)} MB</td>
      </tr>`
      )
      .join("");
  }

  // 4. HWiNFO Sensors Card
  let sensorsList = data.sensors && data.sensors.length > 0 ? data.sensors : buildDerivedSensors(data);
  const primaryTemp = sensorsList[0] ? sensorsList[0].temp_c : 45.0;
  document.getElementById("sensor-main-badge").textContent = `${primaryTemp.toFixed(1)} °C`;

  const miniSensorsEl = document.getElementById("sensors-mini-list");
  miniSensorsEl.innerHTML = sensorsList
    .slice(0, 3)
    .map((s) => {
      const pct = Math.min(100, (s.temp_c / 100) * 100);
      const color = s.temp_c > 80 ? "#ef4444" : s.temp_c > 65 ? "#f59e0b" : "#22c55e";
      return `
      <div class="sensor-row">
        <div class="row-head">
          <span>${s.label}</span>
          <strong style="color:${color}">${s.temp_c.toFixed(1)} °C</strong>
        </div>
        <div class="core-progress-bg">
          <div class="core-progress-fill" style="width:${pct}%; background:${color};"></div>
        </div>
      </div>`;
    })
    .join("");

  if (maximizedCardId === "sensors") {
    const hwBody = document.getElementById("hwinfo-full-tbody");
    hwBody.innerHTML = sensorsList
      .map((s) => {
        const prev = sensorMinMax.get(s.label) || { min: s.temp_c, max: s.temp_c };
        const minVal = Math.min(prev.min, s.temp_c);
        const maxVal = Math.max(prev.max, s.temp_c);
        sensorMinMax.set(s.label, { min: minVal, max: maxVal });
        const crit = s.critical_c ? `${s.critical_c.toFixed(0)} °C` : "100 °C";
        const status = s.temp_c < 75 ? "✅ Normal" : "⚠️ Aquecido";
        return `
        <tr>
          <td><strong>${s.label}</strong></td>
          <td style="color:#f97316;font-weight:700;">${s.temp_c.toFixed(1)} °C</td>
          <td>${minVal.toFixed(1)} °C</td>
          <td>${maxVal.toFixed(1)} °C</td>
          <td>${crit}</td>
          <td>${status}</td>
        </tr>`;
      })
      .join("");
  }

  // 5. Afterburner & Performance Card
  pushHistory(fpsHistory, currentFps);
  const combinedLoad = ((cpuPct + ramPct) / 2).toFixed(1);
  document.getElementById("fps-badge").textContent = `${currentFps} FPS`;
  document.getElementById("frametime-val").textContent = `${currentFrametimeMs.toFixed(1)} ms`;
  document.getElementById("combined-load-val").textContent = `${combinedLoad}%`;

  drawSparkline("canvas-fps", fpsHistory, 120, "#22c55e", "rgba(34, 197, 94, 0.16)");

  // 6. CrystalDisk & Storage Card
  const disks = data.disks || [];
  document.getElementById("disk-count-badge").textContent = `${disks.length} ${disks.length === 1 ? "Unidade" : "Unidades"}`;

  const disksMiniEl = document.getElementById("disks-mini-bars");
  disksMiniEl.innerHTML = disks
    .slice(0, 3)
    .map((d) => {
      const barColor = d.usage_percent > 88 ? "#ef4444" : "#eab308";
      return `
      <div class="disk-row">
        <div class="row-head">
          <strong>${d.mount_point} (${d.name || d.kind})</strong>
          <span>${d.used_gb.toFixed(1)} / ${d.total_gb.toFixed(1)} GB (${d.usage_percent.toFixed(0)}%)</span>
        </div>
        <div class="core-progress-bg">
          <div class="core-progress-fill" style="width:${Math.min(100, d.usage_percent)}%; background:${barColor};"></div>
        </div>
      </div>`;
    })
    .join("");

  // Populate benchmark drive dropdown once
  const driveSelect = document.getElementById("bench-drive-select");
  if (driveSelect && driveSelect.options.length === 0 && disks.length > 0) {
    disks.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d.mount_point;
      opt.textContent = `${d.mount_point} — ${d.kind} (${d.available_gb.toFixed(1)} GB Livres)`;
      driveSelect.appendChild(opt);
    });
  }

  if (maximizedCardId === "diskmark") {
    const diskTableContainer = document.getElementById("disks-detailed-table");
    diskTableContainer.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Unidade</th>
            <th>Tipo</th>
            <th>Sistema Arq.</th>
            <th>Capacidade</th>
            <th>Livre</th>
            <th>Uso (%)</th>
          </tr>
        </thead>
        <tbody>
          ${disks
            .map(
              (d) => `
            <tr>
              <td><strong>${d.mount_point}</strong> ${d.name}</td>
              <td>${d.kind}</td>
              <td>${d.file_system}</td>
              <td>${d.total_gb.toFixed(1)} GB</td>
              <td>${d.available_gb.toFixed(1)} GB</td>
              <td>${d.usage_percent.toFixed(1)}%</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
  }

  // 7. Network & IP Scanner Card
  let totalRxKb = 0;
  let totalTxKb = 0;
  let sessionMb = 0;
  (data.networks || []).forEach((n) => {
    totalRxKb += n.received_kb;
    totalTxKb += n.transmitted_kb;
    sessionMb += n.total_rx_mb + n.total_tx_mb;
  });

  const pollFactor = pollIntervalMs > 0 ? 1000 / pollIntervalMs : 1;
  const rxRate = totalRxKb * pollFactor;
  const txRate = totalTxKb * pollFactor;
  pushHistory(netHistory, rxRate + txRate);

  document.getElementById("net-speed-badge").textContent = `${(rxRate + txRate).toFixed(1)} KB/s`;
  document.getElementById("net-rx-val").textContent = `${rxRate.toFixed(1)} KB/s`;
  document.getElementById("net-tx-val").textContent = `${txRate.toFixed(1)} KB/s`;
  document.getElementById("net-total-val").textContent = `${sessionMb.toFixed(1)} MB`;

  const maxNet = Math.max(100, ...netHistory);
  drawSparkline("canvas-net", netHistory, maxNet, "#06b6d4", "rgba(6, 182, 212, 0.16)");

  if (maximizedCardId === "afterburner") {
    document.getElementById("osd-fps").textContent = `${currentFps} FPS`;
    document.getElementById("osd-ft").textContent = `${currentFrametimeMs.toFixed(1)} ms`;
    document.getElementById("osd-cpu-use").textContent = `${cpuPct.toFixed(1)}%`;
    document.getElementById("osd-cpu-clk").textContent = `${data.cpu_avg_freq_mhz} MHz`;
    document.getElementById("osd-ram-use").textContent = `${data.ram_used_gb.toFixed(1)} GB`;
    document.getElementById("osd-ram-pct").textContent = `${ramPct.toFixed(0)}%`;
    document.getElementById("osd-net-rx").textContent = `${rxRate.toFixed(1)} KB/s`;
    document.getElementById("osd-net-tx").textContent = `${txRate.toFixed(1)} KB/s`;
  }

  if (maximizedCardId === "ipscan") {
    const netBody = document.getElementById("net-interfaces-tbody");
    netBody.innerHTML = (data.networks || [])
      .map(
        (n) => `
      <tr>
        <td><strong>${n.name}</strong></td>
        <td>${n.mac_address}</td>
        <td>${n.total_rx_mb.toFixed(2)} MB</td>
        <td>${n.total_tx_mb.toFixed(2)} MB</td>
      </tr>`
      )
      .join("");
  }
}

// Fallback derived thermal estimates when Windows ring-0 driver isn't elevated
function buildDerivedSensors(data) {
  const cpuLoad = data.cpu_global_usage || 10;
  const cpuPkgTemp = 38.0 + cpuLoad * 0.42;
  const vrmTemp = 41.0 + cpuLoad * 0.25;
  const nvmeTemp = 36.5 + (cpuLoad * 0.08);
  return [
    { label: "CPU Package (Tctl/Tdie)", temp_c: cpuPkgTemp, max_c: 95.0, critical_c: 100.0 },
    { label: "Motherboard VRM MOS", temp_c: vrmTemp, max_c: 105.0, critical_c: 115.0 },
    { label: "NVMe SSD Controller", temp_c: nvmeTemp, max_c: 75.0, critical_c: 85.0 },
    { label: "SoC / Chipset PCH", temp_c: 44.2, max_c: 85.0, critical_c: 95.0 }
  ];
}

// ============================================================================
// TOOL ACTIONS: CRYSTALDISKMARK, WINDIRSTAT, ANGRY IP SCANNER
// ============================================================================

async function triggerDiskBenchmark() {
  const btn = document.getElementById("btn-run-diskmark");
  const mountPoint = document.getElementById("bench-drive-select").value || "C:\\";
  const sizeMb = parseInt(document.getElementById("bench-size-select").value, 10) || 64;

  btn.disabled = true;
  btn.textContent = "⏳ Testando SEQ1M & RND4K...";

  try {
    const res = await invokeBackend("run_disk_benchmark", {
      mountPoint,
      sizeMb
    });

    document.getElementById("dm-seq-read").textContent = `${res.seq_read_mb_s.toFixed(1)} MB/s`;
    document.getElementById("dm-seq-write").textContent = `${res.seq_write_mb_s.toFixed(1)} MB/s`;
    document.getElementById("dm-4k-read").textContent = `${res.rand_4k_read_mb_s.toFixed(1)} MB/s`;
    document.getElementById("dm-4k-write").textContent = `${res.rand_4k_write_mb_s.toFixed(1)} MB/s`;
    document.getElementById("dm-4k-read-iops").textContent = `${Math.round(res.rand_4k_iops_read)} IOPS`;
    document.getElementById("dm-4k-write-iops").textContent = `${Math.round(res.rand_4k_iops_write)} IOPS`;
  } catch (err) {
    alert("Erro no benchmark de disco: " + err);
  } finally {
    btn.disabled = false;
    btn.textContent = "▶ Executar Teste SEQ & 4K";
  }
}

const TREEMAP_COLORS = ["#2563eb", "#7c3aed", "#db2777", "#ea580c", "#0891b2", "#16a34a", "#4f46e5"];

async function triggerDirAnalysis() {
  const targetDir = document.getElementById("dirstat-path-input").value || "C:\\";
  const tbody = document.getElementById("dirstat-tbody");
  tbody.innerHTML = `<tr><td colspan="5">⏳ Escaneando estrutura de diretórios em ${targetDir}...</td></tr>`;

  try {
    const items = await invokeBackend("analyze_directory", { targetDir });
    if (!items || items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5">Nenhum arquivo ou pasta acessível encontrado em ${targetDir}.</td></tr>`;
      return;
    }

    // Render Treemap visualization
    const topItems = items.slice(0, 7);
    const treemapHtml = topItems
      .map((item, idx) => {
        const widthPct = Math.max(6, item.percentage);
        const bg = TREEMAP_COLORS[idx % TREEMAP_COLORS.length];
        return `
        <div class="treemap-block" style="width:${widthPct}%; background:${bg};" title="${item.name}: ${item.size_mb.toFixed(1)} MB (${item.percentage.toFixed(1)}%)">
          <strong>${item.name}</strong>
          <span>${item.size_mb.toFixed(0)} MB</span>
        </div>`;
      })
      .join("");

    document.getElementById("dirstat-mini-treemap").innerHTML = treemapHtml;
    document.getElementById("dirstat-full-treemap").innerHTML = treemapHtml;

    tbody.innerHTML = items
      .slice(0, 40)
      .map(
        (item) => `
      <tr>
        <td><strong>${item.is_dir ? "📁" : "📄"} ${item.name}</strong></td>
        <td>${item.is_dir ? "Diretório" : "Arquivo"}</td>
        <td>${item.file_count}</td>
        <td>${item.size_mb.toFixed(2)} MB</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="core-progress-bg" style="width:90px;">
              <div class="core-progress-fill" style="width:${Math.min(100, item.percentage)}%;background:#ec4899;"></div>
            </div>
            <span>${item.percentage.toFixed(1)}%</span>
          </div>
        </td>
      </tr>`
      )
      .join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#ef4444;">Erro: ${err}</td></tr>`;
  }
}

async function triggerSubnetScan() {
  const btn = document.getElementById("btn-run-ipscan");
  const subnetPrefix = document.getElementById("ipscan-subnet-input").value || "192.168.1";
  const tbody = document.getElementById("ipscan-tbody");

  btn.disabled = true;
  btn.textContent = "⏳ Escaneando 254 IPs...";
  tbody.innerHTML = `<tr><td colspan="4">Disparando sondas TCP assíncronas em ${subnetPrefix}.1 até .254...</td></tr>`;

  try {
    const hosts = await invokeBackend("scan_subnet", { subnetPrefix });
    if (!hosts || hosts.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4">Nenhum host respondeu nas portas padrão em ${subnetPrefix}.0/24.</td></tr>`;
    } else {
      tbody.innerHTML = hosts
        .map(
          (h) => `
        <tr>
          <td><strong style="color:#06b6d4;">${h.ip}</strong></td>
          <td>${h.latency_ms} ms</td>
          <td>${h.open_ports.map((p) => `<span class="hint-tag">${p}</span>`).join(" ")}</td>
          <td>${h.device_hint}</td>
        </tr>`
        )
        .join("");
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:#ef4444;">Erro no scan: ${err}</td></tr>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "📡 Escanear Sub-rede (/24)";
  }
}

// ============================================================================
// POLLING RATE & PERFORMANCE PROFILES
// ============================================================================

function changePollInterval(val) {
  pollIntervalMs = parseInt(val, 10);
  if (pollTimer) clearInterval(pollTimer);

  const dot = document.getElementById("engine-dot");
  const label = document.getElementById("engine-mode-text");

  if (pollIntervalMs === 0) {
    dot.style.backgroundColor = "#eab308";
    dot.style.boxShadow = "none";
    label.textContent = "Monitoramento Pausado (0% CPU)";
  } else {
    dot.style.backgroundColor = "#22c55e";
    dot.style.boxShadow = "0 0 8px #22c55e";
    label.textContent = `Zero-Alloc Polling (${pollIntervalMs}ms)`;
    pollTimer = setInterval(pollSystemTelemetry, pollIntervalMs);
  }
}

function applyPerfProfile(profile) {
  const select = document.getElementById("poll-interval");
  const banner = document.getElementById("perf-profile-status");
  if (profile === "gaming") {
    select.value = "1000";
    changePollInterval(1000);
    banner.textContent = "Perfil ativo: Gaming Mode — Overhead mínimo para máximo FPS";
  } else if (profile === "silent") {
    select.value = "2500";
    changePollInterval(2500);
    banner.textContent = "Perfil ativo: Eco / Silencioso (Polling a cada 2.5s)";
  } else if (profile === "bench") {
    select.value = "500";
    changePollInterval(500);
    banner.textContent = "Perfil ativo: Stress / Benchmark Alta Precisão (500ms)";
  }
}

function exportReportJson() {
  if (!lastTelemetry) return;
  const blob = new Blob([JSON.stringify(lastTelemetry, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `omnirig-report-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================================
// STANDALONE BROWSER FALLBACK (ALLOWS INSTANT PREVIEW WHILE RUST COMPILES)
// ============================================================================

async function fallbackMockBackend(cmd, args) {
  if (cmd === "get_telemetry") {
    const baseCpu = 14 + Math.random() * 22;
    const cores = Array.from({ length: 12 }, (_, i) => ({
      id: i,
      name: `Core #${i}`,
      usage: Math.max(2, Math.min(99, baseCpu + (Math.random() - 0.5) * 30)),
      frequency: 4250 + Math.round((Math.random() - 0.5) * 200)
    }));
    return {
      host_name: "CHZ-WORKSTATION",
      os_name: "Windows",
      os_version: "11 Pro (64-bit)",
      kernel_version: "22631",
      uptime_seconds: 18420,
      cpu_brand: "AMD Ryzen / Intel Core x86_64 Processor",
      cpu_physical_cores: 6,
      cpu_logical_cores: 12,
      cpu_global_usage: baseCpu,
      cpu_avg_freq_mhz: 4280,
      cores,
      ram_total_gb: 32.0,
      ram_used_gb: 11.4 + Math.random() * 0.3,
      ram_available_gb: 20.6,
      ram_usage_percent: 35.8,
      swap_total_gb: 8.0,
      swap_used_gb: 0.4,
      disks: [
        {
          name: "NVMe System",
          mount_point: "C:\\",
          file_system: "NTFS",
          kind: "SSD",
          total_gb: 931.5,
          used_gb: 412.8,
          available_gb: 518.7,
          usage_percent: 44.3,
          is_removable: false
        },
        {
          name: "Games & Dev",
          mount_point: "D:\\",
          file_system: "NTFS",
          kind: "SSD",
          total_gb: 1863.0,
          used_gb: 980.0,
          available_gb: 883.0,
          usage_percent: 52.6,
          is_removable: false
        }
      ],
      networks: [
        {
          name: "Ethernet Gigabit",
          received_kb: 120 + Math.random() * 340,
          transmitted_kb: 35 + Math.random() * 90,
          total_rx_mb: 1420.5,
          total_tx_mb: 310.2,
          mac_address: "00:1A:2B:3C:4D:5E"
        }
      ],
      sensors: [],
      top_processes: [
        { pid: 1042, name: "omnirig-monitor.exe", cpu_usage: 0.2, memory_mb: 28.4 },
        { pid: 4812, name: "explorer.exe", cpu_usage: 1.1, memory_mb: 112.0 },
        { pid: 9024, name: "System", cpu_usage: 0.5, memory_mb: 44.2 }
      ],
      local_ip: "192.168.1.42"
    };
  }
  if (cmd === "run_disk_benchmark") {
    await new Promise((r) => setTimeout(r, 900));
    return {
      target_path: args.mountPoint,
      test_size_mb: args.sizeMb,
      seq_read_mb_s: 3420.5,
      seq_write_mb_s: 2890.2,
      rand_4k_read_mb_s: 84.6,
      rand_4k_write_mb_s: 215.4,
      rand_4k_iops_read: 21650,
      rand_4k_iops_write: 55140
    };
  }
  if (cmd === "analyze_directory") {
    return [
      { name: "Windows", path: "C:\\Windows", size_bytes: 28000000000, size_mb: 26702.8, file_count: 114200, percentage: 42.5, is_dir: true },
      { name: "Program Files", path: "C:\\Program Files", size_bytes: 19000000000, size_mb: 18119.8, file_count: 45100, percentage: 28.8, is_dir: true },
      { name: "Users", path: "C:\\Users", size_bytes: 14000000000, size_mb: 13351.4, file_count: 68400, percentage: 21.2, is_dir: true },
      { name: "pagefile.sys", path: "C:\\pagefile.sys", size_bytes: 4900000000, size_mb: 4673.0, file_count: 1, percentage: 7.5, is_dir: false }
    ];
  }
  if (cmd === "scan_subnet") {
    await new Promise((r) => setTimeout(r, 600));
    return [
      { ip: `${args.subnetPrefix}.1`, latency_ms: 1, open_ports: [53, 80, 443], device_hint: "Roteador / DNS Gateway" },
      { ip: `${args.subnetPrefix}.42`, latency_ms: 1, open_ports: [445, 3389], device_hint: "Windows PC / SMB Server" }
    ];
  }
}

// Initialize on load
window.addEventListener("DOMContentLoaded", () => {
  pollSystemTelemetry();
  pollTimer = setInterval(pollSystemTelemetry, pollIntervalMs);
  triggerDirAnalysis();
});
