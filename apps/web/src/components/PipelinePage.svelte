<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  interface JobKind {
    kind: string;
    label: string;
    description: string;
    acceptsTarget: "none" | "string";
  }

  interface PipelineInfo {
    autoIngest: boolean;
    autoIngestTimeUtc: string;
    nextScheduledRun: string | null;
    runningJobId: string | null;
    kinds: JobKind[];
  }

  interface JobRow {
    id: string;
    kind: string;
    target: string | null;
    status: "QUEUED" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED";
    trigger: "MANUAL" | "SCHEDULED";
    queuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    exitCode: number | null;
    message: string | null;
    progress: { done?: number; total?: number; note?: string | null } | null;
  }

  interface JobDetail extends JobRow {
    args: unknown;
    pid: number | null;
    logTail: string | null;
  }

  interface StageStatus {
    name: string;
    status: "running" | "succeeded" | "failed";
    startedAt: string | null;
    durationSeconds: number | null;
    exitCode: number | null;
    lastLines: string[];
  }

  interface LogStatus {
    logFile: string | null;
    logFileMtime: string | null;
    pipelineHeader: string | null;
    pipelineComplete: boolean;
    pipelineTotalSeconds: number | null;
    abortMessage: string | null;
    stages: StageStatus[];
  }

  let { apiBase }: { apiBase: string } = $props();

  let info = $state<PipelineInfo | null>(null);
  let jobs = $state<JobRow[]>([]);
  let logStatus = $state<LogStatus | null>(null);
  let loading = $state(true);
  let error = $state<string>("");
  let selectedJob = $state<JobDetail | null>(null);
  let selectedId = $state<string | null>(null);
  let enqueueBusy = $state<string | null>(null);
  let manualTarget = $state<Record<string, string>>({});

  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let detailTimer: ReturnType<typeof setInterval> | null = null;

  async function loadInfo(): Promise<void> {
    const response = await fetch(`${apiBase}/api/pipeline/info`);
    if (!response.ok) throw new Error(`Failed to load info: ${response.status}`);
    info = await response.json();
  }

  async function loadJobs(): Promise<void> {
    const response = await fetch(`${apiBase}/api/pipeline/jobs?limit=50`);
    if (!response.ok) throw new Error(`Failed to load jobs: ${response.status}`);
    const payload = await response.json() as { jobs: JobRow[] };
    jobs = payload.jobs;
  }

  async function loadLogStatus(): Promise<void> {
    const response = await fetch(`${apiBase}/api/pipeline/log-status`);
    if (!response.ok) throw new Error(`Failed to load log status: ${response.status}`);
    logStatus = await response.json();
  }

  async function refresh(): Promise<void> {
    try {
      await Promise.all([loadInfo(), loadJobs(), loadLogStatus()]);
      error = "";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Failed to refresh";
    } finally {
      loading = false;
    }
  }

  function formatStageDuration(stage: StageStatus): string {
    if (stage.durationSeconds !== null) {
      const seconds = stage.durationSeconds;
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      const rem = seconds % 60;
      if (minutes < 60) return `${minutes}m ${rem}s`;
      const hours = Math.floor(minutes / 60);
      return `${hours}h ${minutes % 60}m`;
    }
    if (stage.status === "running") return "running…";
    return "—";
  }

  function stageStatusClass(status: StageStatus["status"]): string {
    return `status status-${status === "succeeded" ? "success" : status === "failed" ? "failed" : "running"}`;
  }

  async function loadJobDetail(id: string): Promise<void> {
    try {
      const response = await fetch(`${apiBase}/api/pipeline/jobs/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(`Failed to load job: ${response.status}`);
      const payload = await response.json() as { job: JobDetail };
      selectedJob = payload.job;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Failed to load job";
    }
  }

  function selectJob(id: string): void {
    selectedId = id;
    selectedJob = null;
    void loadJobDetail(id);
  }

  async function enqueue(kind: string, target: string | null): Promise<void> {
    enqueueBusy = kind;
    try {
      const response = await fetch(`${apiBase}/api/pipeline/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, target: target?.trim() || null }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ message: response.statusText }));
        throw new Error(payload.message ?? `HTTP ${response.status}`);
      }
      manualTarget[kind] = "";
      await refresh();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Failed to enqueue";
    } finally {
      enqueueBusy = null;
    }
  }

  async function cancelJob(id: string): Promise<void> {
    try {
      const response = await fetch(`${apiBase}/api/pipeline/jobs/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ message: response.statusText }));
        throw new Error(payload.message ?? `HTTP ${response.status}`);
      }
      await refresh();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Failed to cancel";
    }
  }

  function formatTimestamp(value: string | null | undefined): string {
    if (!value) return "—";
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  }

  function formatDuration(start: string | null, end: string | null): string {
    if (!start) return "—";
    const startMs = new Date(start).getTime();
    const endMs = end ? new Date(end).getTime() : Date.now();
    const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rem = seconds % 60;
    if (minutes < 60) return `${minutes}m ${rem}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  function progressLabel(progress: JobRow["progress"]): string {
    if (!progress) return "";
    if (typeof progress.done === "number" && typeof progress.total === "number" && progress.total > 0) {
      const pct = Math.round((progress.done / progress.total) * 100);
      return `${progress.done}/${progress.total} (${pct}%)${progress.note ? ` · ${progress.note}` : ""}`;
    }
    return progress.note ?? JSON.stringify(progress);
  }

  function statusClass(status: JobRow["status"]): string {
    return `status status-${status.toLowerCase()}`;
  }

  onMount(() => {
    void refresh();
    refreshTimer = setInterval(() => {
      void refresh();
    }, 4000);
    detailTimer = setInterval(() => {
      if (selectedId) void loadJobDetail(selectedId);
    }, 4000);
  });

  onDestroy(() => {
    if (refreshTimer) clearInterval(refreshTimer);
    if (detailTimer) clearInterval(detailTimer);
  });
</script>

<section class="pipeline-page" data-debug-component="PipelinePage">
  <header class="pipeline-head">
    <p class="eyebrow">Operations</p>
    <h2>Ingestion &amp; processing pipeline</h2>
    <p class="muted">
      Daily ingest runs as a scheduled job. Trigger backfills on demand from the panels below.
    </p>
  </header>

  {#if error}
    <p class="pipeline-error">{error}</p>
  {/if}

  <section class="card schedule-card" data-debug-component="PipelineSchedule">
    <h3>Schedule</h3>
    {#if info}
      <dl class="grid">
        <div>
          <dt>Auto-ingest</dt>
          <dd>{info.autoIngest ? "Enabled" : "Disabled (set AUTO_INGEST=true)"}</dd>
        </div>
        <div>
          <dt>Daily run (UTC)</dt>
          <dd>{info.autoIngestTimeUtc}</dd>
        </div>
        <div>
          <dt>Next scheduled</dt>
          <dd>{formatTimestamp(info.nextScheduledRun)}</dd>
        </div>
        <div>
          <dt>Currently running</dt>
          <dd>{info.runningJobId ? info.runningJobId.slice(0, 10) + "…" : "Idle"}</dd>
        </div>
      </dl>
    {:else if loading}
      <p class="muted">Loading…</p>
    {/if}
  </section>

  <section class="card triggers-card" data-debug-component="PipelineTriggers">
    <h3>Trigger a job</h3>
    {#if info}
      <ul class="trigger-list">
        {#each info.kinds as kindDef}
          <li class="trigger-row" data-debug-component={`PipelineTrigger:${kindDef.kind}`}>
            <div class="trigger-meta">
              <strong>{kindDef.label}</strong>
              <span class="muted">{kindDef.description}</span>
            </div>
            <div class="trigger-actions">
              {#if kindDef.acceptsTarget === "string"}
                <input
                  type="text"
                  placeholder="cluster id"
                  bind:value={manualTarget[kindDef.kind]}
                />
              {/if}
              <button
                type="button"
                disabled={enqueueBusy === kindDef.kind || (kindDef.acceptsTarget === "string" && !manualTarget[kindDef.kind]?.trim())}
                onclick={() => enqueue(kindDef.kind, kindDef.acceptsTarget === "string" ? manualTarget[kindDef.kind] ?? null : null)}
              >
                {enqueueBusy === kindDef.kind ? "Queuing…" : "Run"}
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="card live-card" data-debug-component="PipelineLiveStatus">
    <h3>Latest pipeline run</h3>
    {#if logStatus && logStatus.logFile}
      <p class="muted log-meta">
        <code>{logStatus.logFile.replace(/^.*\/logs\//, "logs/")}</code>
        {#if logStatus.pipelineHeader}· {logStatus.pipelineHeader}{/if}
        {#if logStatus.pipelineComplete}· <strong>complete</strong>
          {#if logStatus.pipelineTotalSeconds !== null}({logStatus.pipelineTotalSeconds}s){/if}
        {:else if logStatus.abortMessage}· <strong class="abort">aborted: {logStatus.abortMessage}</strong>
        {:else}· <strong>in progress</strong>
        {/if}
      </p>
      {#if logStatus.stages.length === 0}
        <p class="muted">No stage banners yet — pipeline starting.</p>
      {:else}
        <table class="stages-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Stage</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Exit</th>
            </tr>
          </thead>
          <tbody>
            {#each logStatus.stages as stage (stage.name + (stage.startedAt ?? ""))}
              <tr class:running={stage.status === "running"}>
                <td><span class={stageStatusClass(stage.status)}>{stage.status}</span></td>
                <td>{stage.name}</td>
                <td>{stage.startedAt ?? "—"}</td>
                <td>{formatStageDuration(stage)}</td>
                <td>{stage.exitCode ?? "—"}</td>
              </tr>
              {#if stage.status === "running" && stage.lastLines.length > 0}
                <tr class="tail-row">
                  <td colspan="5">
                    <pre class="stage-tail">{stage.lastLines.join("\n")}</pre>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      {/if}
    {:else if loading}
      <p class="muted">Loading…</p>
    {:else}
      <p class="muted">No <code>logs/pipeline-*.log</code> found.</p>
    {/if}
  </section>

  <section class="card jobs-card" data-debug-component="PipelineJobs">
    <h3>Recent jobs</h3>
    {#if jobs.length === 0}
      <p class="muted">No jobs yet.</p>
    {:else}
      <table class="jobs-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Kind</th>
            <th>Target</th>
            <th>Trigger</th>
            <th>Queued</th>
            <th>Duration</th>
            <th>Progress</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each jobs as job (job.id)}
            <tr class:selected={selectedId === job.id}>
              <td><span class={statusClass(job.status)}>{job.status}</span></td>
              <td>{job.kind}</td>
              <td>{job.target ?? "—"}</td>
              <td>{job.trigger}</td>
              <td>{formatTimestamp(job.queuedAt)}</td>
              <td>{formatDuration(job.startedAt, job.finishedAt)}</td>
              <td>{progressLabel(job.progress)}</td>
              <td class="row-actions">
                <button type="button" onclick={() => selectJob(job.id)}>Logs</button>
                {#if job.status === "RUNNING" || job.status === "QUEUED"}
                  <button type="button" class="danger" onclick={() => cancelJob(job.id)}>Cancel</button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  {#if selectedId}
    <section class="card detail-card" data-debug-component="PipelineJobDetail">
      <header class="detail-head">
        <h3>Job {selectedId.slice(0, 12)}…</h3>
        <button type="button" onclick={() => { selectedId = null; selectedJob = null; }}>Close</button>
      </header>
      {#if selectedJob}
        <dl class="grid">
          <div><dt>Kind</dt><dd>{selectedJob.kind}</dd></div>
          <div><dt>Status</dt><dd>{selectedJob.status}</dd></div>
          <div><dt>Trigger</dt><dd>{selectedJob.trigger}</dd></div>
          <div><dt>Target</dt><dd>{selectedJob.target ?? "—"}</dd></div>
          <div><dt>PID</dt><dd>{selectedJob.pid ?? "—"}</dd></div>
          <div><dt>Exit</dt><dd>{selectedJob.exitCode ?? "—"}</dd></div>
          <div><dt>Started</dt><dd>{formatTimestamp(selectedJob.startedAt)}</dd></div>
          <div><dt>Finished</dt><dd>{formatTimestamp(selectedJob.finishedAt)}</dd></div>
        </dl>
        {#if selectedJob.message}
          <p class="muted">{selectedJob.message}</p>
        {/if}
        <h4>Log tail</h4>
        <pre class="log-tail">{selectedJob.logTail ?? "(no output yet)"}</pre>
      {:else}
        <p class="muted">Loading…</p>
      {/if}
    </section>
  {/if}
</section>

<style>
  .pipeline-page {
    display: grid;
    gap: 16px;
  }

  .pipeline-head h2 {
    margin: 4px 0 0;
  }

  .eyebrow {
    color: var(--muted, #58708f);
    font-size: 0.78rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin: 0;
  }

  .muted {
    color: var(--muted, #58708f);
  }

  .pipeline-error {
    background: #fdecef;
    border-radius: 8px;
    padding: 8px 12px;
    color: #8b1e3f;
    margin: 0;
  }

  .card {
    background: #fff;
    border: 1px solid #e3e8ef;
    border-radius: 12px;
    padding: 16px;
  }

  .card h3 {
    margin: 0 0 12px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin: 0;
  }

  .grid > div {
    border-left: 3px solid #eef1f6;
    padding-left: 8px;
  }

  dt {
    font-size: 0.74rem;
    text-transform: uppercase;
    color: var(--muted, #58708f);
    letter-spacing: 0.04em;
  }

  dd {
    margin: 2px 0 0;
    font-weight: 600;
  }

  .trigger-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }

  .trigger-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border: 1px solid #eef1f6;
    border-radius: 8px;
  }

  .trigger-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .trigger-actions {
    display: flex;
    gap: 6px;
  }

  .trigger-actions input {
    padding: 4px 8px;
    border: 1px solid #cbd3df;
    border-radius: 6px;
    min-width: 200px;
  }

  button {
    padding: 4px 12px;
    border-radius: 6px;
    border: 1px solid #2456a6;
    background: #2456a6;
    color: #fff;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  button.danger {
    background: #fff;
    color: #8b1e3f;
    border-color: #d3a4ad;
  }

  .jobs-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.86rem;
  }

  .jobs-table th,
  .jobs-table td {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid #eef1f6;
    vertical-align: top;
  }

  .jobs-table tr.selected {
    background: #f4f7fc;
  }

  .row-actions {
    display: flex;
    gap: 4px;
  }

  .row-actions button {
    padding: 2px 8px;
    font-size: 0.78rem;
  }

  .status {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 6px;
    font-size: 0.74rem;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .log-meta {
    margin: -4px 0 12px;
    font-size: 0.82rem;
  }

  .log-meta code {
    background: #eef1f6;
    padding: 1px 6px;
    border-radius: 4px;
    margin-right: 4px;
  }

  .log-meta .abort { color: #8b1e3f; }

  .stages-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.86rem;
  }

  .stages-table th,
  .stages-table td {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid #eef1f6;
  }

  .stages-table tr.running td { background: #f4f7fc; }

  .stages-table tr.tail-row td { padding-top: 0; padding-bottom: 12px; }

  .stage-tail {
    background: #0f1620;
    color: #d6e1ef;
    padding: 8px 10px;
    border-radius: 6px;
    overflow-x: auto;
    max-height: 220px;
    font-size: 0.74rem;
    white-space: pre-wrap;
    margin: 4px 0 0;
  }

  .status-queued { background: #eef1f6; color: #4a5566; }
  .status-running { background: #e0ecff; color: #1d4a99; }
  .status-success { background: #e2f3e2; color: #1f6a32; }
  .status-failed { background: #fbe2e7; color: #8b1e3f; }
  .status-cancelled { background: #f6e8c8; color: #7a5316; }

  .detail-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .log-tail {
    background: #0f1620;
    color: #d6e1ef;
    padding: 12px;
    border-radius: 8px;
    overflow-x: auto;
    max-height: 400px;
    font-size: 0.78rem;
    white-space: pre-wrap;
  }
</style>
