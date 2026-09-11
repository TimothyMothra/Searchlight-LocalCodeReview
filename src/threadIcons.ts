/** Fixed decorative SVGs shared by the thread pane and page; visible text supplies the accessible name. */
function icon(body: string): string {
	return `<svg class="thread-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

export const THREAD_ICONS = {
	new: icon('<path d="M8 3v10M3 8h10"/>'),
	read: icon('<path d="M2 2.5h12v9H6l-3 3v-3H2zM5 5.5h6M5 8.5h4"/>'),
	code: icon('<path d="m5 4-4 4 4 4m6-8 4 4-4 4M9 2 7 14"/>'),
	refresh: icon('<path d="M13.4 6A5.5 5.5 0 0 0 3 4.5L1.5 6M1.5 2.5V6H5m-2.4 4A5.5 5.5 0 0 0 13 11.5l1.5-1.5m0 3.5V10H11"/>'),
	resolve: icon('<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="m5 8 2 2 4-4"/>'),
	reopen: icon('<rect x="2.5" y="2.5" width="11" height="11" rx="1"/>'),
	copilot: icon('<rect x="2" y="5" width="12" height="8" rx="2"/><path d="M8 2v3M5 1.5h6M5 8v2m6-2v2M6 13v1.5m4-1.5v1.5"/>'),
	post: icon('<path d="m1.5 2 13 6-13 6 2-6-2-6Zm2 6h11"/>'),
	preview: icon('<path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z"/><circle cx="8" cy="8" r="2"/>'),
	copy: icon('<rect x="5" y="5" width="8" height="9" rx="1"/><path d="M10 5V2H2v9h3"/>'),
	quote: icon('<path d="M2 8h4v5H1V8c0-3 1-4 4-5m6 5h4v5h-5V8c0-3 1-4 4-5"/>'),
	question: icon('<circle cx="8" cy="8" r="6"/><path d="M6 6a2 2 0 0 1 4 0c0 1.5-2 1.5-2 3m0 2v.1"/>'),
	plan: icon('<path d="m2 4 1 1 2-2m2 1h7M2 8h3m2 0h7M2 12h3m2 0h7"/>'),
	risk: icon('<path d="m8 1 7 13H1L8 1Zm0 4v4m0 2v.5"/>'),
};
