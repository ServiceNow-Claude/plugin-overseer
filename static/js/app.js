'use strict';

const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

// ── DOM refs (all declared up front to avoid temporal dead zone errors) ────────

const searchInput  = $('plugin-search');
const searchCount  = $('search-count');
const selectAllCb  = $('select-all');
const updateSelBtn = $('update-selected');
const updateAllBtn = $('update-all');
const modal        = $('script-modal');
const scriptBox    = $('script-output');
const modalClose   = $('modal-close');
const copyBtn      = $('copy-script');

// ── Filter tabs ────────────────────────────────────────────────────────────────

let activeFilter = 'updates';

$$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        $$('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeFilter = tab.dataset.filter;
        applyFilters();
    });
});

function applyFilters() {
    const q = searchInput ? searchInput.value.trim().toLowerCase() : '';
    let visible = 0;

    $$('.plugin-row').forEach(row => {
        const hasUpdate = row.dataset.hasUpdate === 'true';
        const text = [
            row.dataset.name,
            row.dataset.scope,
            row.querySelector('.col-vendor')?.textContent,
        ].join(' ').toLowerCase();

        const matchesSearch = !q || text.includes(q);
        const matchesTab = activeFilter === 'all'
            || (activeFilter === 'updates'  &&  hasUpdate)
            || (activeFilter === 'uptodate' && !hasUpdate);

        const show = matchesSearch && matchesTab;
        row.style.display = show ? '' : 'none';

        const detail = $(`detail-${row.dataset.sysId}`);
        if (detail) detail.style.display = show ? '' : 'none';

        if (show) visible++;
    });

    if (searchCount) {
        const label = activeFilter === 'updates'  ? 'updates'
                    : activeFilter === 'uptodate' ? 'up to date'
                    : 'plugins';
        searchCount.textContent = q ? `${visible} ${label} match` : `${visible} ${label}`;
    }

    if (selectAllCb) selectAllCb.checked = false;
    syncSelButton();
}

// ── Search ─────────────────────────────────────────────────────────────────────

if (searchInput) {
    searchInput.addEventListener('input', applyFilters);
}

// ── Selection ──────────────────────────────────────────────────────────────────

function rowToPlugin(row) {
    return {
        sys_id:         row.dataset.sysId,
        scope:          row.dataset.scope,
        name:           row.dataset.name,
        latest_version: row.dataset.latest,
    };
}

function checkedPlugins() {
    return [...$$('.plugin-cb:checked')].map(cb => rowToPlugin(cb.closest('.plugin-row')));
}

function syncSelButton() {
    const n = $$('.plugin-cb:checked').length;
    if (!updateSelBtn) return;
    updateSelBtn.disabled = n === 0;
    updateSelBtn.textContent = n ? `Update Selected (${n})` : 'Update Selected';
}

if (selectAllCb) {
    selectAllCb.addEventListener('change', () => {
        $$('.plugin-cb').forEach(cb => (cb.checked = selectAllCb.checked));
        syncSelButton();
    });
}

$$('.plugin-cb').forEach(cb => cb.addEventListener('change', syncSelButton));

// ── Row expand / collapse ──────────────────────────────────────────────────────

$$('.plugin-row').forEach(row => {
    row.addEventListener('click', () => {
        const detail = $(`detail-${row.dataset.sysId}`);
        if (!detail) return;
        const isOpen = detail.classList.contains('open');
        row.classList.toggle('expanded', !isOpen);
        detail.classList.toggle('open', !isOpen);
    });
});

// ── Individual update buttons ──────────────────────────────────────────────────

$$('.btn-update').forEach(btn => {
    btn.addEventListener('click', () => {
        const row      = btn.closest('.plugin-row');
        const plugin   = rowToPlugin(row);
        const statusEl = $(`status-${plugin.sys_id}`);
        runUpdate('/api/update', plugin, statusEl, btn);
    });
});

// ── Batch / all update buttons ─────────────────────────────────────────────────

if (updateSelBtn) {
    updateSelBtn.addEventListener('click', () => {
        const plugins = checkedPlugins();
        if (!plugins.length) return;
        runBatch(plugins);
    });
}

if (updateAllBtn) {
    updateAllBtn.addEventListener('click', () => {
        if (!confirm(`Trigger updates for all ${UPDATE_COUNT} plugin(s)?`)) return;
        setGlobalStatus('loading');
        post('/api/update/all', {}).then(handleResult);
    });
}

// ── Core update helpers ────────────────────────────────────────────────────────

async function runUpdate(endpoint, body, statusEl, btn) {
    setStatus(statusEl, 'loading', '⟳');
    if (btn) { btn.disabled = true; btn.classList.add('updating'); }
    const result = await post(endpoint, body);
    handleResult(result, statusEl, btn);
}

function runBatch(plugins) {
    setGlobalStatus('loading');
    post('/api/update/batch', { plugins }).then(result => handleResult(result));
}

function handleResult(result, statusEl, btn) {
    if (btn) { btn.disabled = false; btn.classList.remove('updating'); }

    if (result.success && result.tracker_id) {
        if (statusEl) setStatus(statusEl, 'success', '✓ Queued');
        pollStatus(result.tracker_id, statusEl);
    } else if (result.success) {
        if (statusEl) setStatus(statusEl, 'success', '✓ Queued');
    } else if (result.script) {
        showScriptModal(result.script);
        if (statusEl) setStatus(statusEl, 'error', 'See script');
    } else {
        if (statusEl) setStatus(statusEl, 'error', '✕ Error');
        console.error('[Plugin Overseer]', result.error);
    }
}

function markPluginDone(sysId) {
    const row    = document.querySelector(`.plugin-row[data-sys-id="${sysId}"]`);
    const detail = $(`detail-${sysId}`);
    if (!row) return;

    // Update data so filter logic treats it as up-to-date
    row.dataset.hasUpdate = 'false';
    row.classList.remove('row-needs-update');
    row.classList.add('row-up-to-date');

    // Swap badge
    const badge = row.querySelector('.badge-update');
    if (badge) { badge.className = 'badge badge-ok'; badge.textContent = '✓ Current'; }

    // Remove update button and checkbox
    const updateBtn = row.querySelector('.btn-update');
    if (updateBtn) updateBtn.remove();
    const cb = row.querySelector('.plugin-cb');
    if (cb) cb.remove();

    // Dim the row, then after the animation move it out of the updates tab
    row.classList.add('fading-out');
    if (detail) detail.classList.add('fading-out');

    setTimeout(() => {
        row.classList.remove('fading-out');
        if (detail) detail.classList.remove('fading-out');

        // If still on updates tab, hide it (it'll show under Up to Date / All)
        if (activeFilter === 'updates') {
            row.style.display = 'none';
            if (detail) detail.style.display = 'none';
        }

        // Decrement the Updates Available summary count
        const countEl = document.querySelector('.stat-card.danger .stat-num');
        if (countEl) {
            const n = Math.max(0, parseInt(countEl.textContent) - 1);
            countEl.textContent = n;
            if (n === 0) countEl.closest('.stat-card').classList.remove('danger');
        }

        // Increment Up to Date count
        const upToDateEl = document.querySelector('.stat-card.safe .stat-num');
        if (upToDateEl) upToDateEl.textContent = parseInt(upToDateEl.textContent) + 1;

        // Update tab counts
        const updatesTab = document.querySelector('.tab[data-filter="updates"] .tab-count');
        const uptodateTab = document.querySelector('.tab[data-filter="uptodate"] .tab-count');
        if (updatesTab)  updatesTab.textContent  = Math.max(0, parseInt(updatesTab.textContent) - 1);
        if (uptodateTab) uptodateTab.textContent = parseInt(uptodateTab.textContent) + 1;
    }, 800);
}

// ── Status polling ─────────────────────────────────────────────────────────────

function pollStatus(trackerId, statusEl, attempt = 0) {
    if (attempt > 72) {
        if (statusEl) setStatus(statusEl, 'error', 'Timed out');
        return;
    }
    fetch(`/api/status/${trackerId}`)
        .then(r => r.json())
        .then(data => {
            if (!data.success) return;
            const state = (data.state || '').toLowerCase();
            if (state === 'complete' || state === 'succeeded' || state === 'success') {
                if (statusEl) setStatus(statusEl, 'success', '✓ Done');
                const sysId = statusEl?.id?.replace('status-', '');
                if (sysId) markPluginDone(sysId);
            } else if (state === 'failed' || state === 'error') {
                if (statusEl) setStatus(statusEl, 'error', '✕ Failed');
            } else {
                if (statusEl) setStatus(statusEl, 'loading', data.percent ? `${data.percent}%` : '…');
                setTimeout(() => pollStatus(trackerId, statusEl, attempt + 1), 5000);
            }
        })
        .catch(() => setTimeout(() => pollStatus(trackerId, statusEl, attempt + 1), 8000));
}

// ── Status helpers ─────────────────────────────────────────────────────────────

function setStatus(el, type, text) {
    if (!el) return;
    el.className = `row-status ${type}`;
    el.textContent = text;
}

function setGlobalStatus(type) {
    $$('.plugin-row[data-has-update="true"]').forEach(row => {
        if (type === 'loading') setStatus($(`status-${row.dataset.sysId}`), 'loading', '⟳');
    });
}

// ── Script fallback modal ──────────────────────────────────────────────────────

function showScriptModal(script) {
    if (!modal) return;
    scriptBox.value = script;
    modal.removeAttribute('hidden');
}

if (modalClose) {
    modalClose.addEventListener('click', () => modal.setAttribute('hidden', ''));
}

if (modal) {
    modal.addEventListener('click', e => {
        if (e.target === modal) modal.setAttribute('hidden', '');
    });
}

if (copyBtn) {
    copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(scriptBox.value).then(() => {
            copyBtn.textContent = '✓ Copied!';
            setTimeout(() => (copyBtn.textContent = 'Copy to Clipboard'), 2200);
        });
    });
}

// ── Fetch wrapper ──────────────────────────────────────────────────────────────

async function post(url, body) {
    try {
        const resp = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
        });
        return await resp.json();
    } catch (err) {
        return { success: false, error: String(err) };
    }
}

// ── Init ───────────────────────────────────────────────────────────────────────

applyFilters();
