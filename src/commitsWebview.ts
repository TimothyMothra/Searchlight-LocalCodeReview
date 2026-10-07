/**
 * Compact commit-tree renderer embedded in Comparison. Keeps lazy file expansion and diff actions
 * from the former Commits pane; native VS Code context menus carry the full SHA to Set as Base.
 */
export const COMMITS_CSS = `
.commit-pane { display: flex; flex: 1; flex-direction: column; min-height: 0; }
.commit-pane.collapsed { flex: 0 0 auto; }
.commit-toggle {
	flex: 0 0 auto; padding: 5px 0; border: none; text-align: left; cursor: pointer;
	background: transparent; color: var(--vscode-foreground); font: inherit;
}
.commit-toggle:hover { background: var(--vscode-list-hoverBackground); }
.commit-toggle:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.commit-content { display: flex; flex: 1; flex-direction: column; min-height: 0; }
.commit-content[hidden] { display: none; }
.commit-progress { height: 2px; flex: 0 0 auto; overflow: hidden; position: relative; }
/* ASSUMPTION: the 2px progress slot stays reserved, so loading never moves the commit rows. */
.commit-progress[hidden] { display: block; visibility: hidden; }
.commit-progress[hidden]::before { animation: none; }
.commit-progress::before {
	content: ''; position: absolute; left: 0; width: 2%; height: 100%;
	background: var(--vscode-progressBar-background, var(--vscode-focusBorder));
	/* ASSUMPTION: essential progress motion stays enabled, as in VS Code's native progress bar. */
	animation: commit-progress-slide 4s linear infinite;
}
@keyframes commit-progress-slide {
	from { transform: translateX(0%) scaleX(1); }
	50% { transform: translateX(2500%) scaleX(3); }
	to { transform: translateX(4900%) scaleX(1); }
}
.commit-toolbar { display: flex; justify-content: flex-end; align-items: center; gap: 4px; padding: 5px 0; }
.mode-btn, .more-btn {
	padding: 3px 6px; border: 1px solid transparent; border-radius: 2px; cursor: pointer;
	color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
	font: inherit; font-size: 11px;
}
.mode-btn[aria-pressed="true"] { border-color: var(--vscode-focusBorder); }
.mode-btn:hover, .more-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.mode-btn:disabled, .more-btn:disabled { cursor: default; opacity: 0.6; }
.mode-btn:focus-visible, .more-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.commit-scroll { flex: 1; min-height: 0; overflow: auto; }
#commit-rows { user-select: none; }
.commit-msg { padding: 4px 0; color: var(--vscode-descriptionForeground); font-size: 11px; overflow-wrap: anywhere; }
.commit-row {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 1px 0;
	cursor: pointer;
	white-space: nowrap;
	line-height: 22px;
	height: 24px;
	outline: none;
}
.commit-row:hover { background: var(--vscode-list-hoverBackground); }
.commit-row:focus { background: var(--vscode-list-inactiveSelectionBackground); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.commit-twisty {
	width: 16px;
	min-width: 16px;
	display: inline-flex;
	justify-content: center;
	color: var(--vscode-icon-foreground);
	transition: transform 0.1s;
}
.commit-twisty.spacer { visibility: hidden; }
.commit.collapsed > .commit-row .commit-twisty { transform: rotate(-90deg); }
.commit-glyph {
	width: 16px;
	min-width: 16px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	color: var(--vscode-icon-foreground);
}
.commit-glyph svg, .commit-twisty svg { width: 16px; height: 16px; fill: currentColor; }
.commit-sha {
	font-family: var(--vscode-editor-font-family, monospace);
	color: var(--vscode-descriptionForeground);
	flex-shrink: 0;
}
.commit-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.commit-desc { max-width: 25%; color: var(--vscode-descriptionForeground); font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; }
.commit-badge { flex-shrink: 0; font-size: 10px; padding: 0 3px; border: 1px solid var(--vscode-panel-border); border-radius: 2px; line-height: 16px; }
/* ASSUMPTION: role outlines match toolbar icons without changing the badge's 18px outer height. */
.commit-role { border-width: 1px; border-color: var(--vscode-icon-foreground, var(--vscode-foreground)); line-height: 16px; }
.commit-ref { max-width: 90px; min-width: 0; overflow: hidden; text-overflow: ellipsis; flex-shrink: 1; }
.commit-children { display: block; }
.commit.collapsed > .commit-children { display: none; }
.commit-file { padding-left: 20px; }
.commit-file-error { padding-left: 20px; }
.more-btn { margin: 4px 0; }
@media (max-width: 350px) { .commit-desc, .commit-ref { display: none; } }
`;

/** Runs after the selector script, sharing its message channel and immediate pending-action flag. */
export const COMMITS_JS = `
(() => {
const rows = document.getElementById('commit-rows');
const status = document.getElementById('commit-status');
const more = document.getElementById('commit-more');
const progress = document.getElementById('commit-progress');
const pane = document.getElementById('commit-pane');
const toggleButton = document.getElementById('commit-toggle');
const content = document.getElementById('commit-content');
const modeButtons = {
	history: document.getElementById('commit-history'),
	review: document.getElementById('commit-review'),
};

// Inline SVG glyphs (currentColor) — codicons aren't bundled, so no font is loaded.
const COMMIT_SVG = '<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M10.5 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM8 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/><path d="M1 7.5h4.05v1H1zM10.95 7.5H15v1h-4.05z"/></svg>';
const FILE_SVG = '<svg viewBox="0 0 16 16"><path d="M9.5 1H3.5L3 1.5v13l.5.5h9l.5-.5V5.5L9.5 1zm0 1.4L11.6 4.5H9.5V2.4zM4 14V2h4.5v3.5H12V14H4z"/></svg>';
// ASSUMPTION: expanded artwork points down; the collapsed -90deg rotation points it right.
const CHEVRON_SVG = '<svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4H4z"/></svg>';
let commits = [];
let truncated = false;
let expanded = new Set();
let filesBySha = new Map();
let comparison = {};
let mode = 'history';
let next = null;
let pending = false;
let error = null;
let requestId = 0;
let requestKey = '';
let sectionOpen = false;
let loaded = false;
let actionPending = false;
let actionId = 0;
let actionStart = 0;
let actionReported = false;

function basename(p) {
	const i = p.lastIndexOf('/');
	return i === -1 ? p : p.slice(i + 1);
}
function dirname(p) {
	const i = p.lastIndexOf('/');
	return i === -1 ? '' : p.slice(0, i);
}

function renderCommit(c) {
	const open = expanded.has(c.sha);
	const el = document.createElement('div');
	el.className = 'commit' + (open ? '' : ' collapsed');

	const row = document.createElement('div');
	row.className = 'commit-row';
	row.tabIndex = 0;
	row.setAttribute('role', 'treeitem');
	row.setAttribute('aria-expanded', String(open));
	// ASSUMPTION: VS Code handles webview/context using the nearest data-vscode-context element.
	// Do not prevent contextmenu: the host menu forwards this exact immutable SHA, not a row index.
	row.setAttribute('data-vscode-context', JSON.stringify({
		webviewSection: 'commit', sha: c.sha, preventDefaultContextMenuItems: true,
	}));
	const branches = (comparison.branches || []).filter(b => b.commit === c.sha);
	row.title = c.sha + '\\n' + c.subject + '\\n' + c.author + ', ' + c.relDate +
		(branches.length ? '\\n' + branches.map(b => b.name).join(', ') : '') +
		'\\nRight-click: Set as Base';
	row.innerHTML =
		'<span class="commit-twisty">' + CHEVRON_SVG + '</span>' +
		'<span class="commit-glyph">' + COMMIT_SVG + '</span>' +
		'<span class="commit-sha"></span>' +
		'<span class="commit-label"></span>';
	const shaText = row.querySelector('.commit-sha');
	shaText.textContent = c.shortSha;
	row.querySelector('.commit-label').textContent = c.subject;
	// ASSUMPTION: comparison roles should stay visible before truncating commit text.
	for (const [matches, label, title] of [
		[c.sha === comparison.baseCommit, 'BASE', 'Selected base commit'],
		[c.sha === comparison.mergeBaseCommit && c.sha !== comparison.baseCommit, 'COMMON', 'Common ancestor (merge-base), not a proven original fork'],
		[c.sha === comparison.compareCommit, 'SOURCE', 'Selected source tip'],
	]) {
		if (matches) {
			const badge = document.createElement('span');
			badge.className = 'commit-badge commit-role';
			badge.textContent = label;
			badge.title = title;
			row.insertBefore(badge, shaText);
		}
	}
	if (branches.length) {
		const badge = document.createElement('span');
		badge.className = 'commit-badge commit-ref';
		badge.textContent = branches[0].name;
		badge.title = branches.map(b => b.name).join(', ');
		row.appendChild(badge);
	}
	const desc = document.createElement('span');
	desc.className = 'commit-desc';
	desc.textContent = c.author + ', ' + c.relDate;
	row.appendChild(desc);
	function toggle() {
		vscode.postMessage({ type: 'usageAction', action: expanded.has(c.sha) ? 'collapse' : 'expand' });
		if (expanded.has(c.sha)) {
			expanded.delete(c.sha);
		} else {
			expanded.add(c.sha);
			if (!filesBySha.has(c.sha) || filesBySha.get(c.sha)?.error) {
				filesBySha.set(c.sha, 'loading');
				vscode.postMessage({ type: 'expand', sha: c.sha });
			}
		}
		paint();
	}
	row.addEventListener('click', toggle);
	row.addEventListener('keydown', e => {
		if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
		else if (e.key === 'ArrowRight' && !expanded.has(c.sha)) { e.preventDefault(); toggle(); }
		else if (e.key === 'ArrowLeft' && expanded.has(c.sha)) { e.preventDefault(); toggle(); }
	});
	el.appendChild(row);

	const kids = document.createElement('div');
	kids.className = 'commit-children';
	const files = filesBySha.get(c.sha);
	if (files === 'loading') {
		const l = document.createElement('div');
		l.className = 'commit-msg';
		l.textContent = 'Loading changes…';
		kids.appendChild(l);
	} else if (Array.isArray(files)) {
		for (const relPath of files) {
			const fr = document.createElement('div');
			fr.className = 'commit-row commit-file';
			fr.tabIndex = 0;
			fr.setAttribute('role', 'treeitem');
			fr.title = relPath;
			fr.setAttribute('data-vscode-context', JSON.stringify({
				webviewSection: 'commitFile', sha: c.sha, relPath, preventDefaultContextMenuItems: true,
			}));
			fr.innerHTML =
				'<span class="commit-twisty spacer"></span>' +
				'<span class="commit-glyph">' + FILE_SVG + '</span>' +
				'<span class="commit-label"></span>' +
				'<span class="commit-desc"></span>';
			fr.querySelector('.commit-label').textContent = basename(relPath);
			const dir = dirname(relPath);
			fr.querySelector('.commit-desc').textContent = dir || '';
			function openFile(e) {
				e.stopPropagation();
				vscode.postMessage({ type: 'openCommitFile', sha: c.sha, relPath });
			}
			fr.addEventListener('click', openFile);
			fr.addEventListener('keydown', e => {
				if (e.key === 'Enter') { e.preventDefault(); openFile(e); }
			});
			kids.appendChild(fr);
		}
	} else if (files?.error) {
		const failure = document.createElement('div');
		failure.className = 'commit-msg commit-file-error';
		failure.textContent = files.error + ' Collapse and expand to retry.';
		kids.appendChild(failure);
	}
	el.appendChild(kids);
	return el;
}

function paint() {
	progress.hidden = !(actionPending || baseActionPending || (sectionOpen && pending));
	// ASSUMPTION: collapsed commits do not need DOM work; retain data until the user expands again.
	if (!sectionOpen) { return; }
	const focusedSha = rows.querySelector('.commit-row:focus')?.getAttribute('data-vscode-context');
	rows.replaceChildren();
	const frag = document.createDocumentFragment();
	for (const c of commits) {
		frag.appendChild(renderCommit(c));
	}
	if (truncated) {
		const t = document.createElement('div');
		t.className = 'commit-msg';
		t.textContent = '(' + commits.length + '+ commits — showing ' + commits.length + ')';
		t.title = 'The commit log was truncated for performance. Use the terminal for the full history.';
		frag.appendChild(t);
	}
	rows.appendChild(frag);
	if (focusedSha) {
		for (const row of rows.querySelectorAll('.commit-row')) {
			if (row.getAttribute('data-vscode-context') === focusedSha) { row.focus({ preventScroll: true }); break; }
		}
	}
	status.textContent = mode === 'review' && comparison.baselineError ? comparison.baselineError :
		pending ? 'Loading commits…' : error ||
		(!comparison.compareCommit ? 'Select a source branch.' :
		commits.length === 0 ? 'No commits in range.' : '');
	more.hidden = !next && !error;
	more.disabled = pending;
	more.textContent = error ? '↻ Retry' : '↓ Older commits';
	for (const [name, button] of Object.entries(modeButtons)) {
		button.setAttribute('aria-pressed', String(mode === name));
	}
	modeButtons.review.disabled = !comparison.baseCommit || !!comparison.baselineError;
	if (actionId && !actionReported && !actionPending && !pending) {
		actionReported = true;
		vscode.postMessage({ type: 'baseActionContent', id: actionId, ms: performance.now() - actionStart });
	}
}

function load() {
	if (!sectionOpen || !comparison.compareCommit || pending ||
		(mode === 'review' && (!comparison.baseCommit || comparison.baselineError))) { return; }
	pending = true;
	error = null;
	const id = ++requestId;
	paint();
	vscode.postMessage({ type: 'loadCommits', mode, sourceSha: comparison.compareCommit,
		baseSha: comparison.baseCommit, startSha: next || comparison.compareCommit, requestId: id });
}

function reset() {
	requestId++;
	commits = [];
	next = null;
	truncated = false;
	pending = false;
	loaded = false;
	error = null;
	load();
	paint();
}

for (const [name, button] of Object.entries(modeButtons)) {
	button.addEventListener('click', () => {
		if (mode === name) { return; }
		mode = name;
		requestKey = mode + ':' + comparison.compareCommit + (mode === 'review' ? ':' + comparison.baseCommit : '');
		if (mode === 'review') { requestKey += ':' + !!comparison.baselineError; }
		reset();
	});
}
more.addEventListener('click', load);

function updateDisclosure() {
	toggleButton.setAttribute('aria-expanded', String(sectionOpen));
	toggleButton.textContent = sectionOpen ? '▾ Commits' : '▸ Commits';
	content.hidden = !sectionOpen;
	pane.classList.toggle('collapsed', !sectionOpen);
}

toggleButton.addEventListener('click', () => {
	sectionOpen = !sectionOpen;
	vscode.postMessage({ type: 'usageAction', action: sectionOpen ? 'expand' : 'collapse' });
	updateDisclosure();
	if (sectionOpen) {
		if (!loaded) { load(); }
	}
	paint();
});
updateDisclosure();
progress.hidden = true;

window.addEventListener('message', (e) => {
	const m = e.data;
	if (m.type === 'baseActionStart') {
		if (m.sourceCommit && comparison.compareCommit && m.sourceCommit !== comparison.compareCommit) { return; }
		actionId = m.id;
		actionStart = performance.now();
		actionPending = true;
		actionReported = false;
		paint();
	} else if (m.type === 'baseActionEnd') {
		if (m.id !== actionId) { return; }
		actionPending = false;
		paint();
	} else if (m.type === 'selectionError') {
		actionPending = false;
		paint();
	} else if (m.type === 'state') {
		const changedSource = comparison.compareCommit !== m.compareCommit;
		if (changedSource) { actionId = 0; actionPending = false; }
		comparison = m;
		const key = mode + ':' + m.compareCommit + (mode === 'review' ? ':' + m.baseCommit + ':' + !!m.baselineError : '');
		if (changedSource) { expanded.clear(); filesBySha.clear(); }
		if (key !== requestKey) {
			requestKey = key;
			reset();
		} else { paint(); }
	} else if (m.type === 'commitPage') {
		// ASSUMPTION: only the current mode's pinned source/base snapshot may update this tree.
		if (m.requestId !== requestId || m.sourceSha !== comparison.compareCommit || m.mode !== mode ||
			(mode === 'review' && m.baseSha !== comparison.baseCommit)) { return; }
		pending = false;
		error = m.error || null;
		if (!error) {
			loaded = true;
			commits.push(...m.commits);
			next = m.next || null;
			truncated = !!m.truncated;
		}
		paint();
	} else if (m.type === 'files') {
		filesBySha.set(m.sha, m.error ? { error: m.error } : m.files);
		paint();
	} else if (m.type === 'setExpanded') {
		if (!m.value) { expanded.clear(); }
		paint();
	}
});
})();
`;
