import { runGitQuery } from './git';
import { event, trace } from './diagnostics';

type GitQuery = (args: string[]) => Promise<string>;

export interface Baseline {
	commit: string;
	targetCommit: string;
	reason: string;
}

interface TargetRef {
	name: string;
	commit: string;
	upstream: string;
}

function shortRef(ref: string): string {
	return ref.replace(/^refs\/(heads|remotes)\//, '');
}

/** Exit 1 means "not an ancestor/no common ancestor"; other git failures are errors. */
async function ancestryQuery(query: GitQuery, args: string[]): Promise<string | undefined> {
	try {
		// ASSUMPTION: query arguments/results contain private refs and IDs; record only the
		// fixed query kind, including for injected queries that do not invoke the Git CLI.
		return await trace('baseline.ancestryQuery', () => query(args),
			{ operation: args.includes('--is-ancestor') ? 'isAncestor' : 'mergeBase' });
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
			event('baseline.ancestryMissing', { operation: args.includes('--is-ancestor') ? 'isAncestor' : 'mergeBase' });
			return undefined;
		}
		throw error;
	}
}

/** Resolve a user-supplied commit ID once, and refuse pins invalidated by rewritten history. */
export async function resolveBaselinePin(
	cwd: string,
	value: string,
	compareCommit: string,
	query: GitQuery = (args) => runGitQuery(cwd, args),
): Promise<string> {
	return trace('baseline.resolvePin', () => resolveBaselinePinCore(value, compareCommit, query));
}

async function resolveBaselinePinCore(value: string, compareCommit: string, query: GitQuery): Promise<string> {
	const id = value.trim();
	if (!/^[0-9a-f]{7,64}$/i.test(id)) {
		event('baseline.pinResult', { outcome: 'invalidInput' });
		throw new Error('Enter a commit SHA (at least 7 hexadecimal characters), not a branch name.');
	}
	const commit = await trace('baseline.verifyPin',
		() => query(['rev-parse', '--verify', '--end-of-options', `${id}^{commit}`]));
	if (await ancestryQuery(query, ['merge-base', '--is-ancestor', commit, compareCommit]) === undefined) {
		event('baseline.pinResult', { outcome: 'notAncestor' });
		throw new Error('The pinned baseline is no longer an ancestor of the compare commit. Choose another commit or return to Auto.');
	}
	event('baseline.pinResult', { outcome: 'resolved' });
	return commit;
}

/**
 * ASSUMPTION: the selected target is intentional. Only its configured upstream (or matching
 * origin ref when no upstream is configured) is a candidate; never guess among unrelated branches.
 * Selecting a remote-tracking ref explicitly opts out of local/upstream inference. No fetch occurs.
 */
export async function resolveBaseline(
	cwd: string,
	target: string,
	compareCommit: string,
	pin?: string,
	query: GitQuery = (args) => runGitQuery(cwd, args),
): Promise<Baseline> {
	return trace('baseline.resolve', () => resolveBaselineCore(cwd, target, compareCommit, pin, query),
		{ pinned: !!pin });
}

async function resolveBaselineCore(
	cwd: string,
	target: string,
	compareCommit: string,
	pin: string | undefined,
	query: GitQuery,
): Promise<Baseline> {
	const output = await trace('baseline.refs', () => query([
		'for-each-ref', '--format=%(refname)\t%(objectname)\t%(upstream)', 'refs/heads', 'refs/remotes',
	]));
	const refs: TargetRef[] = output.split(/\r?\n/).filter(Boolean).map((line) => {
		const [name, commit, upstream = ''] = line.split('\t');
		return { name, commit, upstream };
	});
	event('baseline.refCount', { count: refs.length });
	const selected = refs.find((ref) => ref.name === `refs/heads/${target}`)
		?? refs.find((ref) => ref.name === `refs/remotes/${target}`)
		?? refs.find((ref) => ref.name === target);
	if (!selected) {
		event('baseline.result', { outcome: 'targetMissing' });
		throw new Error(`Target branch '${target}' is unavailable. Select an existing target branch.`);
	}
	if (pin) {
		const commit = await resolveBaselinePin(cwd, pin, compareCommit, query);
		event('baseline.result', { outcome: 'resolved', mode: 'pinned' });
		return {
			commit,
			targetCommit: selected.commit,
			reason: 'Pinned commit; unchanged by target updates. Return to Auto to follow shared ancestry.',
		};
	}

	const candidates = [selected];
	if (selected.name.startsWith('refs/heads/')) {
		const upstreamName = selected.upstream || `refs/remotes/origin/${shortRef(selected.name)}`;
		const upstream = refs.find((ref) => ref.name === upstreamName);
		if (upstream && upstream.name !== selected.name) {
			candidates.push(upstream);
		} else if (selected.upstream) {
			event('baseline.result', { outcome: 'upstreamMissing' });
			throw new Error(`Target upstream '${shortRef(selected.upstream)}' is unavailable locally. Fetch it or select an explicit target ref.`);
		}
	}
	event('baseline.candidates', { count: candidates.length, targetKind: selected.name.startsWith('refs/heads/') ? 'local' : 'remote' });

	const bases: { ref: TargetRef; commit: string }[] = [];
	for (const ref of candidates) {
		// Use captured object IDs, not moving refs, for every query in this resolution.
		const output = await ancestryQuery(query, ['merge-base', '--all', ref.commit, compareCommit]);
		const commits = output?.split(/\r?\n/).filter(Boolean) ?? [];
		if (commits.length > 1) {
			event('baseline.result', { outcome: 'multipleMergeBases', count: commits.length });
			throw new Error(`Multiple merge-bases for '${shortRef(ref.name)}'. Pin the intended baseline commit.`);
		}
		if (commits.length === 1) {
			bases.push({ ref, commit: commits[0] });
		}
	}
	if (bases.length === 0) {
		event('baseline.result', { outcome: 'noCommonAncestor' });
		throw new Error('No common ancestor found. Check the target/history (including shallow clones), or pin an ancestor commit.');
	}
	let best = bases[0];
	for (const candidate of bases.slice(1)) {
		if (candidate.commit === best.commit) {
			continue;
		}
		if (await ancestryQuery(query, ['merge-base', '--is-ancestor', best.commit, candidate.commit]) !== undefined) {
			best = candidate;
		} else if (await ancestryQuery(query, ['merge-base', '--is-ancestor', candidate.commit, best.commit]) === undefined) {
			event('baseline.result', { outcome: 'incomparableAncestors' });
			throw new Error('Target refs have incomparable shared ancestors. Select an explicit remote target or pin the intended baseline commit.');
		}
	}
	const considered = candidates.map((ref) => shortRef(ref.name)).join(', ');
	const skipped = candidates.filter((ref) => !bases.some((base) => base.ref === ref));
	event('baseline.result', { outcome: 'resolved', mode: 'auto', candidateCount: candidates.length, skippedCount: skipped.length });
	return {
		commit: best.commit,
		targetCommit: selected.commit,
		reason: `Auto: shared ancestor with ${shortRef(best.ref.name)}; considered ${considered}. Using local refs only.`
			+ (skipped.length ? ` No shared history with ${skipped.map((ref) => shortRef(ref.name)).join(', ')}.` : ''),
	};
}
