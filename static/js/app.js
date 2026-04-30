'use strict';

const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

// ── DOM refs ───────────────────────────────────────────────────────────────────

const searchInput        = $('plugin-search');
const searchCount        = $('search-count');
const selectAllCb        = $('select-all');
const updateSelBtn       = $('update-selected');
const updateAllBtn       = $('update-all');
const modal              = $('script-modal');
const scriptBox          = $('script-output');
const modalClose         = $('modal-close');
const copyBtn            = $('copy-script');
const progressBanner     = $('progress-banner');
const progressBarFill    = $('progress-bar-fill');
const progressBannerLabel = $('progress-banner-label');
const progressBannerMsg  = $('progress-banner-msg');
const progressBannerPct  = $('progress-banner-pct');
const completionToast    = $('completion-toast');
const toastIcon          = $('toast-icon');
const toastText          = $('toast-text');

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
        runSingleUpdate(plugin, statusEl, btn);
    });
});

async function runSingleUpdate(plugin, statusEl, btn) {
    setStatus(statusEl, 'loading', '⟳');
    if (btn) { btn.disabled = true; btn.classList.add('updating'); }

    const result = await post('/api/update', plugin);

    if (btn) { btn.disabled = false; btn.classList.remove('updating'); }

    if (result.success && result.tracker_id) {
        setStatus(statusEl, 'loading', 'Queued');
        pollSingleStatus(result.tracker_id, plugin.sys_id, statusEl);
    } else if (result.success) {
        setStatus(statusEl, 'success', '✓ Queued');
    } else if (result.script) {
        setStatus(statusEl, 'error', 'See script');
        showScriptModal(result.script);
    } else {
        setStatus(statusEl, 'error', '✕ Error');
        console.error('[Plugin Overseer]', result.error);
    }
}

// ── Batch (selected) update ────────────────────────────────────────────────────

if (updateSelBtn) {
    updateSelBtn.addEventListener('click', () => {
        const plugins = checkedPlugins();
        if (!plugins.length) return;
        runBatch(plugins);
    });
}

async function runBatch(plugins) {
    plugins.forEach(p => setStatus($(`status-${p.sys_id}`), 'loading', '⟳'));
    if (updateSelBtn) updateSelBtn.disabled = true;

    const label = `Updating ${plugins.length} plugin${plugins.length !== 1 ? 's' : ''}…`;
    showProgressBanner(label);

    const result = await post('/api/update/batch', { plugins });

    if (updateSelBtn) updateSelBtn.disabled = false;

    if (result.success && result.tracker_id) {
        plugins.forEach(p => setStatus($(`status-${p.sys_id}`), 'loading', 'Queued'));
        pollBatchStatus(result.tracker_id, plugins);
    } else if (result.success) {
        hideProgressBanner();
        plugins.forEach(p => setStatus($(`status-${p.sys_id}`), 'success', '✓ Queued'));
        showToast(`Update queued for ${plugins.length} plugin${plugins.length !== 1 ? 's' : ''}`);
    } else if (result.script) {
        hideProgressBanner();
        plugins.forEach(p => setStatus($(`status-${p.sys_id}`), 'error', 'See script'));
        showScriptModal(result.script);
    } else {
        hideProgressBanner();
        plugins.forEach(p => setStatus($(`status-${p.sys_id}`), 'error', '✕ Error'));
        showToast(result.error || 'Update failed', true);
    }
}

// ── Update All ─────────────────────────────────────────────────────────────────

if (updateAllBtn) {
    updateAllBtn.addEventListener('click', async () => {
        if (!confirm(`Trigger updates for all ${UPDATE_COUNT} plugin(s)?`)) return;

        const allPlugins = [...$$('.plugin-row[data-has-update="true"]')].map(rowToPlugin);
        allPlugins.forEach(p => setStatus($(`status-${p.sys_id}`), 'loading', '⟳'));
        updateAllBtn.disabled = true;

        showProgressBanner(`Updating all ${allPlugins.length} plugins…`);

        const result = await post('/api/update/all', {});

        updateAllBtn.disabled = false;

        if (result.success && result.tracker_id) {
            allPlugins.forEach(p => setStatus($(`status-${p.sys_id}`), 'loading', 'Queued'));
            pollBatchStatus(result.tracker_id, allPlugins);
        } else if (result.success) {
            hideProgressBanner();
            allPlugins.forEach(p => setStatus($(`status-${p.sys_id}`), 'success', '✓ Queued'));
            showToast('All updates queued');
        } else if (result.script) {
            hideProgressBanner();
            allPlugins.forEach(p => setStatus($(`status-${p.sys_id}`), 'error', 'See script'));
            showScriptModal(result.script);
        } else {
            hideProgressBanner();
            showToast(result.error || 'Update failed', true);
        }
    });
}

// ── Status polling — single plugin ─────────────────────────────────────────────

function pollSingleStatus(trackerId, sysId, statusEl, attempt = 0) {
    if (attempt > 72) {
        setStatus(statusEl, 'error', 'Timed out');
        return;
    }
    fetch(`/api/status/${trackerId}`)
        .then(r => r.json())
        .then(data => {
            if (!data.success) {
                setTimeout(() => pollSingleStatus(trackerId, sysId, statusEl, attempt + 1), 5000);
                return;
            }
            const state = (data.state || '').toLowerCase();
            const pct   = data.percent || 0;

            if (isTerminalSuccess(state)) {
                setStatus(statusEl, 'success', '✓ Done');
                markPluginDone(sysId);
            } else if (isTerminalFailure(state)) {
                setStatus(statusEl, 'error', '✕ Failed');
            } else {
                setStatus(statusEl, 'loading', pct ? `${pct}%` : '…');
                setTimeout(() => pollSingleStatus(trackerId, sysId, statusEl, attempt + 1), 5000);
            }
        })
        .catch(() => setTimeout(() => pollSingleStatus(trackerId, sysId, statusEl, attempt + 1), 8000));
}

// ── Status polling — batch ─────────────────────────────────────────────────────

function pollBatchStatus(trackerId, plugins, attempt = 0) {
    if (attempt > 120) {
        hideProgressBanner();
        plugins.forEach(p => setStatus($(`status-${p.sys_id}`), 'error', 'Timed out'));
        showToast('Update timed out — check ServiceNow App Manager', true);
        return;
    }

    fetch(`/api/status/${trackerId}`)
        .then(r => r.json())
        .then(data => {
            if (!data.success) {
                setTimeout(() => pollBatchStatus(trackerId, plugins, attempt + 1), 5000);
                return;
            }

            const state = (data.state || '').toLowerCase();
            const pct   = parseInt(data.percent) || 0;
            const msg   = data.message || '';

            updateProgressBanner(pct, msg);
            const stateLabel = pct > 0 ? `${pct}%`
                             : (state === 'queued' || state === 'pending' || state === '' || !state) ? 'Queued…'
                             : state;
            plugins.forEach(p => setStatus($(`status-${p.sys_id}`), 'loading', stateLabel));

            if (isTerminalSuccess(state)) {
                hideProgressBanner();
                plugins.forEach(p => {
                    setStatus($(`status-${p.sys_id}`), 'success', '✓ Done');
                    markPluginDone(p.sys_id);
                });
                showToast(`${plugins.length} plugin${plugins.length !== 1 ? 's' : ''} updated successfully`);
            } else if (isTerminalFailure(state)) {
                hideProgressBanner();
                plugins.forEach(p => setStatus($(`status-${p.sys_id}`), 'error', '✕ Failed'));
                showToast(`Update failed — ${msg || 'check ServiceNow for details'}`, true);
            } else {
                setTimeout(() => pollBatchStatus(trackerId, plugins, attempt + 1), 5000);
            }
        })
        .catch(() => setTimeout(() => pollBatchStatus(trackerId, plugins, attempt + 1), 8000));
}

function isTerminalSuccess(state) {
    return ['complete', 'succeeded', 'success', 'installed'].includes(state);
}

function isTerminalFailure(state) {
    return ['failed', 'error', 'cancelled', 'complete_with_errors'].includes(state);
}

// ── Row completion ─────────────────────────────────────────────────────────────

function markPluginDone(sysId) {
    const row    = document.querySelector(`.plugin-row[data-sys-id="${sysId}"]`);
    const detail = $(`detail-${sysId}`);
    if (!row) return;

    row.dataset.hasUpdate = 'false';
    row.classList.remove('row-needs-update');
    row.classList.add('row-up-to-date');

    const badge = row.querySelector('.badge-update');
    if (badge) { badge.className = 'badge badge-ok'; badge.textContent = '✓ Current'; }

    const updateBtn = row.querySelector('.btn-update');
    if (updateBtn) updateBtn.remove();
    const cb = row.querySelector('.plugin-cb');
    if (cb) cb.remove();

    row.classList.add('fading-out');
    if (detail) detail.classList.add('fading-out');

    setTimeout(() => {
        row.classList.remove('fading-out');
        if (detail) detail.classList.remove('fading-out');

        if (activeFilter === 'updates') {
            row.style.display = 'none';
            if (detail) detail.style.display = 'none';
        }

        const countEl = document.querySelector('.stat-card.danger .stat-num');
        if (countEl) {
            const n = Math.max(0, parseInt(countEl.textContent) - 1);
            countEl.textContent = n;
            if (n === 0) countEl.closest('.stat-card').classList.remove('danger');
        }

        const upToDateEl = document.querySelector('.stat-card.safe .stat-num');
        if (upToDateEl) upToDateEl.textContent = parseInt(upToDateEl.textContent) + 1;

        const updatesTab  = document.querySelector('.tab[data-filter="updates"] .tab-count');
        const uptodateTab = document.querySelector('.tab[data-filter="uptodate"] .tab-count');
        if (updatesTab)  updatesTab.textContent  = Math.max(0, parseInt(updatesTab.textContent) - 1);
        if (uptodateTab) uptodateTab.textContent = parseInt(uptodateTab.textContent) + 1;
    }, 800);
}

// ── Progress banner ────────────────────────────────────────────────────────────

function showProgressBanner(label) {
    if (!progressBanner) return;
    progressBannerLabel.textContent = label;
    progressBannerMsg.textContent   = '';
    progressBarFill.style.width     = '0%';
    progressBannerPct.textContent   = '0%';
    progressBanner.classList.add('visible');
}

function updateProgressBanner(pct, msg) {
    if (!progressBanner) return;
    progressBarFill.style.width   = `${pct}%`;
    progressBannerPct.textContent = pct > 0 ? `${pct}%` : 'Queued';
    progressBannerMsg.textContent = msg || (pct === 0 ? 'Waiting for other installs to complete…' : '');
}

function hideProgressBanner() {
    if (!progressBanner) return;
    progressBanner.classList.remove('visible');
}

// ── Toast ──────────────────────────────────────────────────────────────────────

let toastTimeout;
function showToast(text, isError = false) {
    if (!completionToast) return;
    toastIcon.textContent = isError ? '✕' : '✓';
    toastText.textContent = text;
    completionToast.classList.toggle('error', isError);
    completionToast.removeAttribute('hidden');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => completionToast.setAttribute('hidden', ''), 5000);
}

// ── Status helpers ─────────────────────────────────────────────────────────────

function setStatus(el, type, text) {
    if (!el) return;
    el.className = `row-status ${type}`;
    el.textContent = text;
}

// ── Script fallback modal ──────────────────────────────────────────────────────

function showScriptModal(script) {
    if (!modal) return;
    scriptBox.value = script;
    // Point the link directly to the background scripts page on this instance
    const linkEl = $('bg-script-link');
    if (linkEl) {
        const instance = document.querySelector('.instance-pill')?.textContent?.replace('.service-now.com', '').trim();
        if (instance) {
            linkEl.href = `https://${instance}.service-now.com/sys_script.do`;
        }
    }
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
