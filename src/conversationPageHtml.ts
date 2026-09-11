import type * as vscode from 'vscode';
import { getNonce } from './webviewShell';
import { THREAD_ICONS } from './threadIcons';

/**
 * Conversation webview shell.
 *
 * ASSUMPTION: the parent renders message/preview HTML with raw HTML disabled and images removed.
 * Only those rendered fragments enter HTML slots; metadata is always assigned via textContent.
 */
export function conversationPageHtml(webview: vscode.Webview): string {
	const nonce = getNonce();
	const csp = [
		"default-src 'none'",
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}'`,
		"img-src data:",
	].join('; ');

	const style = /* css */ `
:root {
  color-scheme: dark;
  --sl-bg: var(--vscode-editor-background, #111318);
  --sl-panel: color-mix(in srgb, var(--vscode-sideBar-background, #161a22) 92%, #000 8%);
  --sl-panel-2: color-mix(in srgb, var(--vscode-editorWidget-background, #171c24) 96%, #000 4%);
  --sl-panel-3: color-mix(in srgb, var(--vscode-input-background, #1a1f28) 96%, #000 4%);
  --sl-border: color-mix(in srgb, var(--vscode-widget-border, #2d3442) 72%, #000 28%);
  --sl-border-strong: color-mix(in srgb, var(--vscode-focusBorder, #5c8cff) 52%, #2f3646 48%);
  --sl-text: var(--vscode-foreground, #e6ebf3);
  --sl-muted: var(--vscode-descriptionForeground, #a7b0c0);
  --sl-accent: var(--vscode-textLink-foreground, #7aa2ff);
  --sl-accent-strong: var(--vscode-button-background, #4a78ff);
  --sl-accent-text: var(--vscode-button-foreground, #ffffff);
  --sl-danger: color-mix(in srgb, #e57373 78%, var(--sl-text) 22%);
  --sl-success: color-mix(in srgb, #60c48f 74%, var(--sl-text) 26%);
  --sl-warn: color-mix(in srgb, #d6a74f 78%, var(--sl-text) 22%);
  --sl-radius: 8px;
  --sl-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
  --sl-shadow-soft: 0 6px 18px rgba(0, 0, 0, 0.12);
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
body.vscode-light, body.vscode-high-contrast-light { color-scheme: light; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, #3f4754); border-radius: 8px; }
::-webkit-scrollbar-track { background: transparent; }
html, body { height: 100%; }
body {
  margin: 0;
  padding: 0;
  color: var(--sl-text);
  background:
    radial-gradient(1200px 600px at 0% 0%, rgba(122, 162, 255, 0.08), transparent 45%),
    radial-gradient(900px 500px at 100% 0%, rgba(96, 196, 143, 0.05), transparent 42%),
    var(--sl-bg);
  font-family:
    var(--vscode-font-family, Inter, Segoe UI, system-ui, sans-serif);
  font-size: 14px;
  line-height: 1.45;
  overflow: hidden;
}
button, input, textarea, summary {
  font: inherit;
}
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--sl-panel-3);
  color: var(--sl-text);
  padding: 5px 9px;
  cursor: pointer;
  transition: transform 120ms ease, background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
.button-icon { display: inline-flex; flex: 0 0 14px; width: 14px; height: 14px; }
.button-icon svg { width: 14px; height: 14px; }
button:hover:not(:disabled) { transform: translateY(-1px); }
button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
button:focus-visible,
input:focus-visible,
textarea:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--sl-border-strong);
  outline-offset: 2px;
}
a {
  color: var(--sl-accent);
}
.shell {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  height: 100vh;
}
.hero {
  position: sticky;
  top: 0;
  z-index: 5;
  padding: 9px 12px 8px;
  border-bottom: 1px solid var(--sl-border);
  backdrop-filter: blur(18px);
  background: color-mix(in srgb, var(--sl-bg) 82%, transparent 18%);
}
.eyebrow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--sl-muted);
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}
.eyebrow-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: linear-gradient(135deg, var(--sl-accent-strong), color-mix(in srgb, var(--sl-accent-strong) 55%, #8bd3ff 45%));
  color: var(--sl-accent-text);
  font-size: 11px;
  font-weight: 700;
}
.title-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  justify-content: space-between;
}
.title-block {
  min-width: 0;
}
.title {
  margin: 0;
  font-size: 20px;
  line-height: 1.25;
  font-weight: 650;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}
.subtitle {
  margin-top: 5px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--sl-muted);
}
.pill,
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border: 1px solid var(--sl-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--sl-panel) 84%, transparent 16%);
  color: var(--sl-muted);
  font-size: 12px;
  white-space: nowrap;
}
.pill strong,
.badge strong {
  color: var(--sl-text);
  font-weight: 600;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}
.actions .primary {
  background: var(--sl-accent-strong);
  color: var(--sl-accent-text);
}
.actions .ghost {
  background: transparent;
  border-color: var(--sl-border);
}
.actions .warn {
  border-color: color-mix(in srgb, var(--sl-warn) 30%, var(--sl-border) 70%);
}
.statusline {
  margin-top: 6px;
  min-height: 18px;
  color: var(--sl-muted);
  font-size: 12px;
}
.statusline strong {
  color: var(--sl-text);
  font-weight: 600;
}
.notice,
.alert {
  margin: 8px 12px 0;
  padding: 8px 10px;
  border: 1px solid var(--sl-border);
  border-radius: var(--sl-radius);
  background: var(--sl-panel);
  box-shadow: var(--sl-shadow-soft);
}
.notice {
  color: var(--sl-muted);
}
.notice strong {
  color: var(--sl-text);
}
.alert {
  border-color: color-mix(in srgb, var(--sl-danger) 42%, var(--sl-border) 58%);
  background: color-mix(in srgb, var(--sl-danger) 10%, var(--sl-panel) 90%);
  color: var(--sl-text);
}
.alert[hidden],
.notice[hidden],
.empty[hidden],
.preview[hidden] {
  display: none;
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 10px;
  min-height: 0;
  padding: 10px 12px;
}
.main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
.timeline {
  /* Content-sized by default; long threads shrink and scroll instead of displacing the composer. */
  flex: 0 1 auto;
  min-height: 0;
  overflow: auto;
  padding-right: 2px;
}
.timeline:focus-visible {
  outline: 2px solid var(--sl-border-strong);
  outline-offset: 4px;
  border-radius: 14px;
}
.message {
  margin-bottom: 8px;
  border: 1px solid var(--sl-border);
  border-left-width: 4px;
  border-radius: 10px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--sl-panel-2) 96%, transparent 4%), var(--sl-panel));
  box-shadow: var(--sl-shadow-soft);
  overflow: hidden;
}
.message--human { border-left-color: color-mix(in srgb, var(--sl-success) 55%, var(--sl-border) 45%); }
.message--agent { border-left-color: color-mix(in srgb, var(--sl-accent-strong) 58%, var(--sl-border) 42%); }
.message--unknown { border-left-color: color-mix(in srgb, var(--sl-warn) 58%, var(--sl-border) 42%); }
.message-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--sl-border) 82%, transparent 18%);
}
.identity {
  min-width: 0;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
}
.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 700;
  color: var(--sl-text);
  background: color-mix(in srgb, var(--sl-panel-3) 74%, transparent 26%);
  border: 1px solid var(--sl-border);
  flex: 0 0 auto;
}
.name-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.message-name {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}
.kind {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 999px;
  border: 1px solid var(--sl-border);
  color: var(--sl-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.meta {
  margin-top: 0;
  color: var(--sl-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.timestamp {
  flex: 0 0 auto;
  color: var(--sl-muted);
  font-size: 12px;
  white-space: nowrap;
}
.message-body {
  padding: 10px;
  overflow-wrap: anywhere;
}
.message-body :first-child { margin-top: 0; }
.message-body :last-child { margin-bottom: 0; }
.message-body p, .message-body ul, .message-body ol, .message-body blockquote, .message-body pre {
  margin: 0 0 8px;
}
.message-body blockquote {
  padding: 8px 12px;
  border-left: 3px solid var(--sl-border-strong);
  background: color-mix(in srgb, var(--sl-panel-3) 82%, transparent 18%);
  color: var(--sl-muted);
  border-radius: 10px;
}
.message-body code {
  padding: 0.14em 0.32em;
  border-radius: 6px;
  background: color-mix(in srgb, var(--sl-panel-3) 88%, transparent 12%);
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 0.95em;
}
.message-body pre {
  overflow: auto;
  padding: 0;
  border: 1px solid var(--sl-border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--sl-panel-3) 88%, transparent 12%);
}
.message-body pre code {
  display: block;
  padding: 8px 10px;
  white-space: pre;
  background: transparent;
}
.code-frame {
  margin: 6px 0 8px;
  border: 1px solid var(--sl-border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--sl-panel-3) 88%, transparent 12%);
  overflow: hidden;
}
.code-actions {
  display: flex;
  justify-content: flex-end;
  padding: 4px 6px 0;
}
.code-actions button {
  padding: 3px 7px;
  border-radius: 8px;
  font-size: 12px;
}
.quote-action {
  margin-left: auto;
  background: transparent;
  border-color: var(--sl-border);
}
.message-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 10px 8px;
}
.message-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-left: auto;
}
.message-tools button {
  padding: 3px 7px;
  font-size: 12px;
}
.empty {
  /* ASSUMPTION: starter guidance should not expand to fill unused editor height. */
  flex: 0 0 auto;
  padding: 10px;
  border: 1px dashed var(--sl-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--sl-panel) 84%, transparent 16%);
}
.empty h2 {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 650;
}
.empty p {
  margin: 0 0 12px;
  color: var(--sl-muted);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  border-color: var(--sl-border);
  background: transparent;
}
.composer,
.sidebar {
  border: 1px solid var(--sl-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--sl-panel) 92%, transparent 8%);
  box-shadow: var(--sl-shadow-soft);
}
.composer {
  flex: 0 0 auto;
  padding: 10px;
}
.composer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
}
.composer-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}
.composer-note {
  color: var(--sl-muted);
  font-size: 12px;
}
.field {
  display: grid;
  gap: 4px;
  margin-bottom: 8px;
}
.field label {
  color: var(--sl-muted);
  font-size: 12px;
  font-weight: 600;
}
.field input,
.field textarea {
  width: 100%;
  border: 1px solid var(--sl-border);
  border-radius: 8px;
  background: var(--sl-panel-3);
  color: var(--sl-text);
  padding: 7px 9px;
}
.field input::placeholder,
.field textarea::placeholder {
  color: color-mix(in srgb, var(--sl-muted) 80%, transparent 20%);
}
.field textarea {
  min-height: 80px;
  resize: vertical;
}
.composer-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.composer-actions .primary {
  background: var(--sl-accent-strong);
  color: var(--sl-accent-text);
}
.composer-actions .ghost {
  background: transparent;
  border-color: var(--sl-border);
}
.shortcut {
  margin-left: auto;
  color: var(--sl-muted);
  font-size: 12px;
}
.preview {
  flex: 0 0 auto;
  max-height: 260px;
  overflow: auto;
  padding: 10px;
  border: 1px solid var(--sl-border);
  border-radius: 16px;
  background: color-mix(in srgb, var(--sl-panel-2) 94%, transparent 6%);
}
.preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.preview-head h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
}
.preview-body {
  color: var(--sl-text);
}
.saved-anchor { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family, monospace); }
.sidebar {
  align-self: start;
  max-height: 100%;
  padding: 10px;
  overflow: auto;
  min-width: 0;
}
.side-section + .side-section {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--sl-border);
}
.side-title {
  margin: 0 0 5px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--sl-muted);
}
.side-value {
  margin: 0;
  color: var(--sl-text);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tag {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--sl-border);
  background: color-mix(in srgb, var(--sl-panel-3) 88%, transparent 12%);
  color: var(--sl-muted);
  font-size: 12px;
}
.details {
  margin-top: 10px;
  border: 1px solid var(--sl-border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--sl-panel-3) 82%, transparent 18%);
  overflow: hidden;
}
.details summary {
  padding: 10px 12px;
  cursor: pointer;
  color: var(--sl-text);
  font-weight: 600;
}
.details .details-body {
  padding: 0 12px 12px;
  color: var(--sl-muted);
}
.details .details-body .line {
  margin: 0 0 6px;
}
.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 220px;
  color: var(--sl-muted);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@media (max-width: 1040px) {
  body { overflow: auto; }
  .shell { height: auto; min-height: 100vh; }
  .layout { grid-template-columns: minmax(0, 1fr); }
  .sidebar { order: 0; }
}
@media (max-width: 720px) {
  .hero { padding-inline: 12px; }
  .layout { padding: 12px; gap: 12px; }
  .title-row { flex-direction: column; }
  .actions { justify-content: flex-start; }
  .message-head { flex-direction: column; }
  .timestamp { white-space: normal; }
  .message-foot, .composer-actions { flex-direction: column; align-items: stretch; }
  .shortcut { margin-left: 0; }
}
`;

	const script = /* js */ `
const vscode = acquireVsCodeApi();
const BUTTON_ICONS = ${JSON.stringify(THREAD_ICONS)};
const saved = vscode.getState() || {};
const persistent = {
  reference: Object.prototype.hasOwnProperty.call(saved, 'reference') ? saved.reference : null,
  draftBody: typeof saved.draftBody === 'string' ? saved.draftBody : '',
  draftTitle: typeof saved.draftTitle === 'string' ? saved.draftTitle : '',
};

const nodes = {
  title: document.getElementById('page-title'),
  subtitle: document.getElementById('page-subtitle'),
  status: document.getElementById('page-status'),
  alert: document.getElementById('page-alert'),
  alertText: document.getElementById('page-alert-text'),
  banner: document.getElementById('page-banner'),
  bannerText: document.getElementById('page-banner-text'),
  loading: document.getElementById('page-loading'),
  timeline: document.getElementById('timeline'),
  empty: document.getElementById('empty-state'),
  emptyTitle: document.getElementById('empty-title'),
  emptyBody: document.getElementById('empty-body'),
  emptyChips: document.getElementById('empty-chips'),
  composer: document.getElementById('composer'),
  composerTitleWrap: document.getElementById('composer-title-wrap'),
  composerTitle: document.getElementById('composer-title'),
  composerBody: document.getElementById('composer-body'),
  composerHint: document.getElementById('composer-hint'),
  postButton: document.getElementById('post-button'),
  postAskButton: document.getElementById('post-ask-button'),
  previewToggle: document.getElementById('preview-toggle'),
  previewPanel: document.getElementById('preview-panel'),
  previewBody: document.getElementById('preview-body'),
  sidebar: document.getElementById('sidebar'),
  reviewLabel: document.getElementById('sidebar-review-label'),
  reviewMeta: document.getElementById('sidebar-review-meta'),
  reviewMode: document.getElementById('sidebar-mode'),
  reviewState: document.getElementById('sidebar-state'),
  reviewTags: document.getElementById('sidebar-tags'),
  reviewTagsSection: document.getElementById('sidebar-tags-section'),
  reviewLocation: document.getElementById('sidebar-location'),
  reviewLocationBody: document.getElementById('sidebar-location-body'),
  openCodeButton: document.getElementById('open-code-button'),
  askButton: document.getElementById('ask-button'),
  resolveButton: document.getElementById('resolve-button'),
  refreshButton: document.getElementById('refresh-button'),
};

let pageData = null;
let pendingAction = '';
let previewOpen = false;
let ready = false;
let pendingSubmission = null;
let previewRequest = 0;
let previewTimer;
const messageSignatures = new WeakMap();

function setButtonLabel(button, icon, title) {
  button.textContent = '';
  const glyph = document.createElement('span');
  glyph.className = 'button-icon';
  glyph.setAttribute('aria-hidden', 'true');
  // ASSUMPTION: only the fixed icon table is used here, never message or author content.
  glyph.innerHTML = BUTTON_ICONS[icon];
  const text = document.createElement('span');
  text.textContent = title;
  button.appendChild(glyph);
  button.appendChild(text);
}

document.querySelectorAll('button[data-icon]').forEach((button) => {
  setButtonLabel(button, button.dataset.icon, button.textContent);
});

function syncBusyIndicator(flag) {
  document.querySelector('main')?.setAttribute('aria-busy', String(!!flag));
}

nodes.composerBody.value = persistent.draftBody;
nodes.composerTitle.value = persistent.draftTitle;

function savePersistentState() {
  persistent.draftBody = nodes.composerBody.value;
  persistent.draftTitle = nodes.composerTitle.value;
  vscode.setState({
    reference: persistent.reference,
    draftBody: persistent.draftBody,
    draftTitle: persistent.draftTitle,
  });
}

function setStatus(text) {
  nodes.status.textContent = text || '';
}

function setAlert(text) {
  if (text) {
    nodes.alert.hidden = false;
    nodes.alertText.textContent = text;
  } else {
    nodes.alert.hidden = true;
    nodes.alertText.textContent = '';
  }
}

function kindLabel(kind) {
  return kind === 'agent' ? 'Agent' : kind === 'human' ? 'Human' : 'Unknown';
}

function avatarLabel(comment) {
  if (comment.kind === 'agent') { return 'AI'; }
  if (comment.kind === 'human') { return comment.name.split(/\\s+/).slice(0, 2).map((part) => Array.from(part)[0] || '').join('').toUpperCase() || 'H'; }
  return '?';
}

function isNearBottom(node) {
  return (node.scrollHeight - node.clientHeight - node.scrollTop) < 28;
}

function quoteBody(body) {
  return body.split(/\\r?\\n/).map((line) => '> ' + line).join('\\n');
}

function insertIntoComposer(text) {
  if (pendingAction || !pageData?.writable || pageData.legacy) { return; }
  const input = nodes.composerBody;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const insertion = text;
  input.value = before + insertion + after;
  const caret = before.length + insertion.length;
  input.selectionStart = caret;
  input.selectionEnd = caret;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

function prefillComposer(text) {
  if (pendingAction || !pageData?.writable || pageData.legacy) { return; }
  if (nodes.composerBody.value.trim()) { insertIntoComposer('\\n\\n' + text); return; }
  nodes.composerBody.value = text;
  nodes.composerBody.dispatchEvent(new Event('input', { bubbles: true }));
  nodes.composerBody.focus();
  nodes.composerBody.selectionStart = nodes.composerBody.selectionEnd = nodes.composerBody.value.length;
}

function attachCodeTools(scope) {
  scope.querySelectorAll('pre').forEach((pre) => {
    if (pre.dataset.codeFrame === '1') { return; }
    pre.dataset.codeFrame = '1';
    const frame = document.createElement('div');
    frame.className = 'code-frame';
    frame.dataset.codeFrame = '1';
    const actions = document.createElement('div');
    actions.className = 'code-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    setButtonLabel(copy, 'copy', 'Copy code');
    copy.addEventListener('click', () => {
      const code = pre.querySelector('code')?.textContent || pre.textContent || '';
      vscode.postMessage({ type: 'usage', action: 'copyCode' });
      vscode.postMessage({ type: 'copyText', text: code });
    });
    const parent = pre.parentNode;
    if (!parent) { return; }
    parent.insertBefore(frame, pre);
    frame.appendChild(actions);
    actions.appendChild(copy);
    frame.appendChild(pre);
  });
}

function buildMessageCard(comment, index) {
  const article = document.createElement('article');
  article.className = 'message message--' + comment.kind;
  article.setAttribute('data-index', String(index));

  const head = document.createElement('header');
  head.className = 'message-head';

  const identity = document.createElement('div');
  identity.className = 'identity';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = avatarLabel(comment);

  const metaWrap = document.createElement('div');
  metaWrap.className = 'meta-wrap';

  const nameRow = document.createElement('div');
  nameRow.className = 'name-row';

  const name = document.createElement('h3');
  name.className = 'message-name';
  name.textContent = comment.name;

  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = kindLabel(comment.kind);

  nameRow.appendChild(name);
  nameRow.appendChild(kind);

  if (comment.details) {
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = comment.details;
    nameRow.appendChild(meta);
  }

  metaWrap.appendChild(nameRow);
  identity.appendChild(avatar);
  identity.appendChild(metaWrap);

  const timestamp = document.createElement('time');
  timestamp.className = 'timestamp';
  timestamp.textContent = comment.timestamp;
  timestamp.setAttribute('title', comment.timestamp);

  head.appendChild(identity);
  head.appendChild(timestamp);

  const body = document.createElement('div');
  body.className = 'message-body';
  body.innerHTML = comment.html;
  attachCodeTools(body);

  const foot = document.createElement('div');
  foot.className = 'message-foot';
  const tools = document.createElement('div');
  tools.className = 'message-tools';
  const copyMessage = document.createElement('button');
  copyMessage.type = 'button';
  setButtonLabel(copyMessage, 'copy', 'Copy message');
  copyMessage.addEventListener('click', () => {
    vscode.postMessage({ type: 'usage', action: 'copyMessage' });
    vscode.postMessage({ type: 'copyText', text: comment.body });
  });
  tools.appendChild(copyMessage);
  const quote = document.createElement('button');
  quote.type = 'button';
  quote.className = 'quote-action';
  setButtonLabel(quote, 'quote', 'Quote');
  quote.disabled = !pageData?.writable || !!pageData?.legacy || !!pendingAction;
  quote.addEventListener('click', () => {
    vscode.postMessage({ type: 'usage', action: 'quote' });
    const quoted = quoteBody(comment.body);
    insertIntoComposer((nodes.composerBody.value.trim() ? '\\n\\n' : '') + quoted + '\\n');
  });
  tools.appendChild(quote);
  foot.appendChild(document.createElement('span'));
  foot.appendChild(tools);

  article.appendChild(head);
  article.appendChild(body);
  article.appendChild(foot);
  return article;
}

function updatePreview() {
  if (!previewOpen) { return; }
  clearTimeout(previewTimer);
  const requestId = ++previewRequest;
  previewTimer = setTimeout(() => {
    if (previewOpen) { vscode.postMessage({ type: 'preview', body: nodes.composerBody.value, requestId }); }
  }, 150);
}

function renderEmptyState(data) {
  const isEmpty = data.comments.length === 0;
  nodes.empty.hidden = !isEmpty;
  if (!isEmpty) { return; }

  if (data.mode === 'new') {
    nodes.emptyTitle.textContent = 'Start a review thread';
    nodes.emptyBody.textContent = 'Start a review-wide topic without attaching it to a file or line. Ask a question, explain a concern, or leave a message for Copilot.';
    nodes.emptyChips.innerHTML = '';
    const starters = [
      { label: 'Ask a question', icon: 'question', text: 'I have a question about this review:\\n\\n' },
      { label: 'Plan the review', icon: 'plan', text: 'Here is the review plan I would like to discuss:\\n\\n' },
      { label: 'Flag a risk', icon: 'risk', text: 'I want to flag a risk or edge case:\\n\\n' },
    ];
    starters.forEach((starter) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      setButtonLabel(chip, starter.icon, starter.label);
      chip.disabled = !data.writable || data.legacy || !!pendingAction;
      chip.addEventListener('click', () => prefillComposer(starter.text));
      nodes.emptyChips.appendChild(chip);
    });
  } else {
    nodes.emptyTitle.textContent = 'No saved messages yet';
    nodes.emptyBody.textContent = 'Replies you save here will appear in chronological order. Use Quote to pull a saved message into the composer.';
    nodes.emptyChips.innerHTML = '';
  }
}

function renderSidebar(data) {
  nodes.reviewLabel.textContent = data.reviewLabel;
  nodes.reviewMeta.textContent = data.mode === 'new'
    ? 'New thread'
    : (data.number ? 'Thread #' + String(data.number) : 'Saved thread');
  nodes.reviewMode.textContent = data.mode === 'new' ? 'Draft' : 'Thread';
  nodes.reviewState.textContent = data.mode === 'new' ? 'Not posted' : data.resolved ? 'Resolved' : 'Open';
  nodes.reviewState.className = 'pill ' + (data.resolved ? 'resolved' : 'open');

  nodes.reviewTags.innerHTML = '';
  nodes.reviewTagsSection.hidden = !data.tags.length;
  data.tags.forEach((tag) => {
    const span = document.createElement('span');
    span.className = 'tag';
    span.textContent = tag;
    nodes.reviewTags.appendChild(span);
  });

  nodes.reviewLocation.hidden = !data.location;
  if (data.location) {
    nodes.reviewLocationBody.innerHTML = '';
    const line = document.createElement('div');
    line.className = 'line';
    line.textContent = data.location.label;
    nodes.reviewLocationBody.appendChild(line);
    if (data.location.anchor) {
      const anchor = document.createElement('pre');
      anchor.className = 'saved-anchor';
      anchor.textContent = data.location.anchor;
      nodes.reviewLocationBody.appendChild(anchor);
    }
  }

  nodes.openCodeButton.hidden = !data.location;
  nodes.askButton.hidden = !(data.mode === 'thread' && data.canAskCopilot);
  nodes.resolveButton.hidden = data.mode !== 'thread';
  nodes.askButton.disabled = !!data.busy || !!pendingAction;
  nodes.resolveButton.disabled = !data.writable || data.legacy || !!data.busy || !!pendingAction;
  setButtonLabel(nodes.resolveButton, data.resolved ? 'reopen' : 'resolve', data.resolved ? 'Reopen' : 'Resolve');
}

function renderComposer(data) {
  const readOnly = !data.writable || data.legacy;
  nodes.composerTitleWrap.hidden = data.mode !== 'new';
  nodes.composerTitle.readOnly = readOnly;
  nodes.composerBody.readOnly = readOnly;
  nodes.composerTitle.disabled = !!pendingAction;
  nodes.composerBody.disabled = !!pendingAction;
  document.querySelectorAll('.quote-action, .chip').forEach((button) => {
    button.disabled = readOnly || !!data.busy || !!pendingAction;
  });

  nodes.composerTitle.placeholder = data.mode === 'new'
    ? 'Short subject for the discussion'
    : '';
  nodes.composerBody.placeholder = data.mode === 'new'
    ? 'Write the opening message for this review-wide thread…'
    : 'Write a reply to the saved thread…';

  nodes.postButton.disabled = readOnly || !!data.busy || !!pendingAction || nodes.composerBody.value.trim().length === 0;
  nodes.postAskButton.disabled = readOnly || !!data.busy || !!pendingAction || nodes.composerBody.value.trim().length === 0;
  nodes.previewToggle.disabled = !!data.busy || !!pendingAction;
  nodes.refreshButton.disabled = !!data.busy || !!pendingAction;

  nodes.composerHint.textContent = data.mode === 'thread'
    ? 'Markdown supported. Replies stay in this thread.'
    : 'Optional subject. Markdown supported.';
}

function renderTimeline(data) {
  const keepBottom = isNearBottom(nodes.timeline);
  const previousScrollTop = nodes.timeline.scrollTop;

  nodes.timeline.hidden = data.comments.length === 0;
  const previousCards = Array.from(nodes.timeline.children);
  data.comments.forEach((comment, index) => {
    const signature = JSON.stringify(comment);
    if (previousCards[index] && messageSignatures.get(previousCards[index]) === signature) { return; }
    const card = buildMessageCard(comment, index);
    messageSignatures.set(card, signature);
    if (previousCards[index]) { previousCards[index].replaceWith(card); }
    else { nodes.timeline.appendChild(card); }
  });
  while (nodes.timeline.children.length > data.comments.length) { nodes.timeline.lastElementChild.remove(); }

  nodes.loading.hidden = true;
  renderEmptyState(data);
  if (data.comments.length > 0) {
    nodes.empty.hidden = true;
  }

  if (keepBottom) {
    nodes.timeline.scrollTop = nodes.timeline.scrollHeight;
  } else {
    nodes.timeline.scrollTop = previousScrollTop;
  }
}

function syncDocumentTitle(data) {
  const prefix = data.mode === 'new' ? 'New thread' : data.title;
  document.title = 'Searchlight — ' + prefix;
}

function renderState(data) {
  pageData = data;
  syncDocumentTitle(data);
  syncBusyIndicator(data.busy || !!pendingAction);

  nodes.title.textContent = data.title;
  nodes.subtitle.innerHTML = '';

  const modePill = document.createElement('span');
  modePill.className = 'pill';
  modePill.textContent = data.location ? 'Code-linked' : 'Review-wide';

  const statusPill = document.createElement('span');
  statusPill.className = 'pill';
  statusPill.textContent = data.busy || !!pendingAction ? 'Working…' : data.mode === 'new' ? 'Draft' : (data.resolved ? 'Resolved' : 'Open');

  const accessPill = document.createElement('span');
  accessPill.className = 'pill';
  accessPill.textContent = data.legacy ? 'Read-only legacy thread' : (data.writable ? 'Local only' : 'Read-only');

  nodes.subtitle.appendChild(modePill);
  nodes.subtitle.appendChild(statusPill);
  nodes.subtitle.appendChild(accessPill);

  nodes.loading.hidden = true;
  nodes.banner.hidden = !data.banner;
  if (data.banner) {
    nodes.bannerText.textContent = data.banner;
  }

  renderSidebar(data);
  renderComposer(data);
  renderTimeline(data);
  updatePreview();
  savePersistentState();
}

function submitPost(askCopilot) {
  if (!pageData || pendingAction || pageData.busy || !pageData.writable || pageData.legacy) { return; }
  const body = nodes.composerBody.value;
  const title = nodes.composerTitle.value;
  if (!body.trim()) {
    setAlert('Write a message before posting.');
    return;
  }
  setAlert('');
  pendingAction = 'post';
  pendingSubmission = { body, title };
  syncBusyIndicator(true);
  renderComposer(pageData);
  renderSidebar(pageData);
  setStatus(askCopilot ? 'Saving and launching Copilot…' : 'Saving message…');

  const message = { type: 'post', body, askCopilot: !!askCopilot };
  const cleanTitle = title.trim();
  if (pageData.mode === 'new' && cleanTitle) {
    message.title = cleanTitle;
  }
  vscode.postMessage(message);
}

function handleMessage(event) {
  const message = event.data;
  if (!message || typeof message.type !== 'string') { return; }
  if (message.type === 'preview') {
    if (previewOpen && message.requestId === previewRequest && typeof message.html === 'string') {
      nodes.previewBody.innerHTML = message.html;
      attachCodeTools(nodes.previewBody);
    }
    return;
  }

  if (message.type === 'state') {
    persistent.reference = Object.prototype.hasOwnProperty.call(message, 'reference') ? message.reference : null;
    nodes.loading.hidden = true;
    const data = message.data;
    if (!data || typeof data !== 'object') { return; }
    renderState(data);
    if (!ready) {
      ready = true;
      setStatus(data.mode === 'new' ? 'Your draft stays local until you post.' : 'Messages are saved locally and update as replies arrive.');
      if (data.mode === 'new' && data.writable) { nodes.composerBody.focus(); }
    }
    return;
  }

  if (message.type === 'result') {
    if (message.action === 'post') {
      pendingAction = '';
      syncBusyIndicator(false);
      if (message.clearDraft && pendingSubmission &&
          nodes.composerBody.value === pendingSubmission.body &&
          nodes.composerTitle.value === pendingSubmission.title) {
        nodes.composerBody.value = '';
        nodes.composerTitle.value = '';
        savePersistentState();
        updatePreview();
      }
      pendingSubmission = null;
      if (pageData) { renderState({ ...pageData, busy: false }); }
      if (message.ok) {
        setAlert('');
        setStatus(message.message || 'Saved.');
      } else {
        setAlert(message.message || 'The action failed.');
        setStatus(message.message || 'The action failed.');
      }
    } else if (message.action === 'askCopilot' || message.action === 'setResolved') {
      pendingAction = '';
      syncBusyIndicator(false);
      if (pageData) { renderState({ ...pageData, busy: false }); }
      if (message.ok) {
        setAlert('');
        setStatus(message.message || 'Updated.');
      } else {
        setAlert(message.message || 'The action failed.');
        setStatus(message.message || 'The action failed.');
      }
    } else if (message.action === 'refresh' || message.action === 'copyText' || message.action === 'openLink' || message.action === 'openCode' || message.action === 'preview') {
      if (message.ok) {
        setStatus(message.message || 'Done.');
      } else {
        setAlert(message.message || 'The action failed.');
        setStatus(message.message || 'The action failed.');
      }
    }
    return;
  }
}

window.addEventListener('message', handleMessage);
window.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) { return; }
  const anchor = target.closest('a[href]');
  if (anchor) {
    const href = anchor.getAttribute('href');
    if (href) {
      event.preventDefault();
      vscode.postMessage({ type: 'openLink', href });
    }
  }
});

nodes.composerBody.addEventListener('input', () => {
  savePersistentState();
  renderComposer(pageData || { mode: 'new', title: '', reviewLabel: '', resolved: false, writable: true, legacy: false, tags: [], comments: [], busy: false, canAskCopilot: false });
  updatePreview();
});
nodes.composerTitle.addEventListener('input', savePersistentState);
nodes.composer.addEventListener('submit', (event) => event.preventDefault());
nodes.composerBody.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    submitPost(false);
  }
});
nodes.composerTitle.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    submitPost(false);
  }
});

nodes.postButton.addEventListener('click', () => submitPost(false));
nodes.postAskButton.addEventListener('click', () => submitPost(true));
nodes.previewToggle.addEventListener('click', () => {
  previewOpen = !previewOpen;
  nodes.previewPanel.hidden = !previewOpen;
  nodes.previewToggle.setAttribute('aria-pressed', String(previewOpen));
  if (previewOpen) {
    vscode.postMessage({ type: 'usage', action: 'previewDraft' });
    updatePreview();
  }
});
nodes.askButton.addEventListener('click', () => {
  if (pendingAction) { return; }
  pendingAction = 'askCopilot';
  syncBusyIndicator(true);
  if (pageData) { renderComposer(pageData); renderSidebar(pageData); }
  setAlert('');
  setStatus('Launching Copilot…');
  vscode.postMessage({ type: 'askCopilot' });
});
nodes.resolveButton.addEventListener('click', () => {
  if (!pageData || pendingAction || !pageData.writable || pageData.legacy) { return; }
  pendingAction = 'setResolved';
  syncBusyIndicator(true);
  renderComposer(pageData);
  renderSidebar(pageData);
  setAlert('');
  setStatus(pageData.resolved ? 'Reopening thread…' : 'Resolving thread…');
  vscode.postMessage({ type: 'setResolved', resolved: !pageData.resolved });
});
nodes.refreshButton.addEventListener('click', () => {
  if (pendingAction) { return; }
  setStatus('Refreshing…');
  vscode.postMessage({ type: 'refresh' });
});
nodes.openCodeButton.addEventListener('click', () => {
  if (pendingAction || nodes.openCodeButton.hidden) { return; }
  vscode.postMessage({ type: 'openCode' });
});

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) { return; }
  const button = target.closest('[data-prefill]');
  if (button) {
    const text = button.getAttribute('data-prefill');
    if (text) { prefillComposer(text); }
  }
});

vscode.postMessage({ type: 'ready' });
setStatus('Loading thread…');
`;

	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${style}</style>
</head>
<body>
  <div class="shell">
    <header class="hero">
      <div class="eyebrow"><span class="eyebrow-badge">S</span><span>Searchlight / Thread</span></div>
      <div class="title-row">
        <div class="title-block">
          <h1 id="page-title" class="title">Thread</h1>
          <div id="page-subtitle" class="subtitle" aria-label="thread summary"></div>
          <div id="page-status" class="statusline" role="status" aria-live="polite"></div>
        </div>
        <div class="actions" aria-label="thread actions">
          <button id="refresh-button" data-icon="refresh" type="button" class="ghost">Refresh</button>
          <button id="ask-button" data-icon="copilot" type="button" class="primary" title="Ask Copilot about posted messages only; unsent drafts are not included" hidden>Ask Copilot</button>
          <button id="open-code-button" data-icon="code" type="button" class="ghost" hidden>Open code</button>
          <button id="resolve-button" data-icon="resolve" type="button" class="warn" hidden>Resolve</button>
        </div>
      </div>
    </header>

    <div class="feedback">
      <div id="page-banner" class="notice" hidden><span id="page-banner-text"></span></div>
      <div id="page-alert" class="alert" role="alert" aria-live="assertive" hidden><span id="page-alert-text"></span></div>
      <div id="page-loading" class="loading">Loading thread…</div>
    </div>

    <main class="layout" aria-busy="false">
      <section class="main" aria-label="thread timeline">
        <div id="timeline" class="timeline" role="log" aria-live="polite" aria-relevant="additions text" tabindex="0"></div>

        <section id="empty-state" class="empty" hidden aria-label="starter guidance">
          <h2 id="empty-title">Start the thread</h2>
          <p id="empty-body"></p>
          <div id="empty-chips" class="chips"></div>
        </section>

        <form id="composer" class="composer" autocomplete="off">
          <div class="composer-head">
            <h2>Compose</h2>
            <div id="composer-hint" class="composer-note">Ctrl/Cmd+Enter saves a message.</div>
          </div>
          <div id="composer-title-wrap" class="field">
            <label for="composer-title">Subject</label>
            <input id="composer-title" type="text" placeholder="Short subject for the discussion">
          </div>
          <div class="field">
            <label for="composer-body">Message</label>
            <textarea id="composer-body" placeholder="Write a message…" spellcheck="true"></textarea>
          </div>
          <div class="composer-actions">
            <button id="post-button" data-icon="post" type="button" class="primary">Post</button>
            <button id="post-ask-button" data-icon="copilot" type="button" class="ghost">Post &amp; Ask Copilot</button>
            <button id="preview-toggle" data-icon="preview" type="button" class="ghost" aria-pressed="false">Preview draft</button>
            <span class="shortcut">Ctrl/Cmd+Enter = Post</span>
          </div>
        </form>

        <section id="preview-panel" class="preview" hidden aria-label="draft preview">
          <div class="preview-head">
            <h2>Draft preview</h2>
            <span class="composer-note">Rendered locally. Nothing is saved or sent.</span>
          </div>
          <div id="preview-body" class="preview-body message-body"></div>
        </section>
      </section>

      <aside id="sidebar" class="sidebar" aria-label="review summary">
        <section class="side-section">
          <h2 class="side-title">Review</h2>
          <p id="sidebar-review-label" class="side-value"></p>
          <p id="sidebar-review-meta" class="side-value" style="margin-top: 6px; color: var(--sl-muted);"></p>
        </section>

        <section class="side-section">
          <h2 class="side-title">State</h2>
          <div class="tag-list">
            <span id="sidebar-mode" class="tag"></span>
            <span id="sidebar-state" class="pill"></span>
          </div>
        </section>

        <section id="sidebar-tags-section" class="side-section">
          <h2 class="side-title">Tags</h2>
          <div id="sidebar-tags" class="tag-list"></div>
        </section>

        <section id="sidebar-location" class="side-section" hidden>
          <h2 class="side-title">Saved code context</h2>
          <details class="details">
            <summary>Show saved anchor context</summary>
            <div id="sidebar-location-body" class="details-body"></div>
          </details>
        </section>

        <section class="side-section">
          <h2 class="side-title">Notes</h2>
          <p class="side-value" style="color: var(--sl-muted);">
            Ask Copilot launches the CLI using posted messages. Unsent drafts are never included.
          </p>
        </section>
      </aside>
    </main>
  </div>
</body>
<script nonce="${nonce}">${script}</script>
</html>`;
}
