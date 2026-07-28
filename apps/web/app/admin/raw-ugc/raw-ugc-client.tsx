'use client';

import * as React from 'react';
import { Download, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  checkRawUgcStatusAction,
  listRawUgcVoicesAction,
  submitRawUgcAction,
  type RawUgcVoice,
} from './actions';

/**
 * Polish-25.6 Commit 35: admin raw UGC client form.
 *
 * Layout: three-pane on desktop —
 *   1. Left: avatar grid with filter chips (gender / age / ethnicity)
 *      + text search on avatar name.
 *   2. Middle: script textarea + optional voice picker + submit.
 *   3. Right: status / preview panel — starts empty, fills with
 *      polling status while processing, flips to <video> + download
 *      link on completion.
 *
 * Polling: every 5 seconds after submit, up to 40 attempts (~3 min
 * total — MakeUGC videos usually complete in 30-90s). Aborts on
 * status=failed or on timeout.
 *
 * Zero DB persistence — MakeUGC's CDN URL is the deliverable.
 */

export interface AvatarOption {
  id: string;
  name: string;
  thumbnailUrl: string;
  gender: string;
  ageBucket: string;
  ethnicity: string;
  hairColor: string;
  wardrobeStyle: string | null;
  backgroundSetting: string | null;
}

interface Props {
  avatars: AvatarOption[];
}

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'polling'; videoId: string; attempts: number }
  | { kind: 'done'; videoId: string; url: string }
  // Polish-25.6 Commit 36: distinct "still processing after poll cap"
  // state. Not an error — MakeUGC credit was already charged and the
  // video is legitimately still generating. Recheck button fires
  // `checkRawUgcStatusAction` on demand so the admin can resume
  // watching without regenerating.
  | { kind: 'processing_timeout'; videoId: string; rechecking: boolean }
  | { kind: 'error'; message: string };

const POLL_INTERVAL_MS = 5_000;
// Polish-25.6 Commit 36: bumped 40 → 120 polls (10 min at 5s each).
// MakeUGC queue backups occasionally push videos past the old 3.3 min
// cap; false timeouts were the operator's first-real-use bug report.
const MAX_POLL_ATTEMPTS = 120;

export function RawUgcClient({ avatars }: Props) {
  const [selectedAvatar, setSelectedAvatar] = React.useState<AvatarOption | null>(null);
  const [script, setScript] = React.useState('');
  const [voiceId, setVoiceId] = React.useState<string>('');
  const [voices, setVoices] = React.useState<RawUgcVoice[] | null>(null);
  const [voicesLoading, setVoicesLoading] = React.useState(false);
  const [status, setStatus] = React.useState<Status>({ kind: 'idle' });

  // Filters
  const [genderFilter, setGenderFilter] = React.useState<string>('');
  const [ageFilter, setAgeFilter] = React.useState<string>('');
  const [ethnicityFilter, setEthnicityFilter] = React.useState<string>('');
  const [nameQuery, setNameQuery] = React.useState('');

  const filterOptions = React.useMemo(() => {
    const genders = new Set<string>();
    const ages = new Set<string>();
    const ethnicities = new Set<string>();
    for (const a of avatars) {
      genders.add(a.gender);
      ages.add(a.ageBucket);
      ethnicities.add(a.ethnicity);
    }
    return {
      genders: Array.from(genders).sort(),
      ages: Array.from(ages).sort(),
      ethnicities: Array.from(ethnicities).sort(),
    };
  }, [avatars]);

  const filteredAvatars = React.useMemo(() => {
    const needle = nameQuery.trim().toLowerCase();
    return avatars.filter((a) => {
      if (genderFilter && a.gender !== genderFilter) return false;
      if (ageFilter && a.ageBucket !== ageFilter) return false;
      if (ethnicityFilter && a.ethnicity !== ethnicityFilter) return false;
      if (needle && !a.name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [avatars, genderFilter, ageFilter, ethnicityFilter, nameQuery]);

  // Load voices when the admin picks an avatar. Debounced to only
  // load once per avatar switch. Kept as a separate fetch so page
  // load doesn't wait on the 15s MakeUGC voices endpoint.
  React.useEffect(() => {
    if (!selectedAvatar) return;
    let cancelled = false;
    setVoicesLoading(true);
    setVoices(null);
    setVoiceId('');
    listRawUgcVoicesAction(selectedAvatar.gender)
      .then((r) => {
        if (cancelled) return;
        if (r.ok) setVoices(r.voices);
        else setVoices([]);
      })
      .catch(() => {
        if (!cancelled) setVoices([]);
      })
      .finally(() => {
        if (!cancelled) setVoicesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAvatar]);

  // Polling effect — fires when status.kind === 'polling'.
  React.useEffect(() => {
    if (status.kind !== 'polling') return;
    const timer = setTimeout(async () => {
      const r = await checkRawUgcStatusAction(status.videoId);
      if (!r.ok || r.status === 'failed') {
        setStatus({
          kind: 'error',
          message: r.errorMessage ?? 'MakeUGC returned status=failed with no reason.',
        });
        return;
      }
      if (r.status === 'completed' && r.url) {
        setStatus({ kind: 'done', videoId: status.videoId, url: r.url });
        return;
      }
      if (status.attempts + 1 >= MAX_POLL_ATTEMPTS) {
        // Polish-25.6 Commit 36: MakeUGC status is still non-terminal
        // (processing / queued) after the poll cap. Flip to the
        // processing_timeout state so the operator sees "still generating
        // — check back" instead of a red error. Credit is already spent
        // on MakeUGC; the video will land eventually.
        setStatus({ kind: 'processing_timeout', videoId: status.videoId, rechecking: false });
        return;
      }
      setStatus({ kind: 'polling', videoId: status.videoId, attempts: status.attempts + 1 });
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [status]);

  // Polish-25.6 Commit 36: manual recheck triggered from the
  // processing_timeout panel. Re-uses `checkRawUgcStatusAction` — no
  // new server action needed. Three outcomes: still processing →
  // stays in processing_timeout with the rechecking flag flipped
  // back to false; completed → 'done' with the video URL; failed
  // → 'error'.
  async function recheckStatus(videoId: string) {
    setStatus({ kind: 'processing_timeout', videoId, rechecking: true });
    const r = await checkRawUgcStatusAction(videoId);
    if (!r.ok || r.status === 'failed') {
      setStatus({
        kind: 'error',
        message: r.errorMessage ?? 'MakeUGC returned status=failed with no reason.',
      });
      return;
    }
    if (r.status === 'completed' && r.url) {
      setStatus({ kind: 'done', videoId, url: r.url });
      return;
    }
    // Still processing — keep the operator in the processing_timeout
    // panel so they can re-poll again after another wait.
    setStatus({ kind: 'processing_timeout', videoId, rechecking: false });
  }

  async function handleSubmit() {
    if (!selectedAvatar) return;
    if (!script.trim()) return;
    setStatus({ kind: 'submitting' });
    const r = await submitRawUgcAction({
      avatarId: selectedAvatar.id,
      voiceId: voiceId || undefined,
      script,
    });
    if (!r.ok || !r.videoId) {
      setStatus({ kind: 'error', message: r.errorMessage ?? 'Submit failed.' });
      return;
    }
    setStatus({ kind: 'polling', videoId: r.videoId, attempts: 0 });
  }

  const busy =
    status.kind === 'submitting' ||
    status.kind === 'polling' ||
    (status.kind === 'processing_timeout' && status.rechecking);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
      {/* PANE 1 — avatar picker */}
      <section className="bg-bg-surface flex flex-col rounded-sm border">
        <div className="border-b px-3 py-2">
          <p className="text-fg-subtle text-[10px] font-semibold uppercase tracking-wider">
            Avatars — {filteredAvatars.length} / {avatars.length}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <FilterChip
              label="Gender"
              value={genderFilter}
              options={filterOptions.genders}
              onChange={setGenderFilter}
            />
            <FilterChip
              label="Age"
              value={ageFilter}
              options={filterOptions.ages}
              onChange={setAgeFilter}
            />
            <FilterChip
              label="Ethnicity"
              value={ethnicityFilter}
              options={filterOptions.ethnicities}
              onChange={setEthnicityFilter}
            />
            <div className="relative min-w-[10rem] flex-1">
              <Search className="text-fg-subtle absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search name…"
                value={nameQuery}
                onChange={(e) => setNameQuery(e.target.value)}
                className="bg-bg-inset text-fg placeholder:text-fg-subtle h-7 w-full rounded-sm border pl-6 pr-2 text-xs"
              />
            </div>
          </div>
        </div>
        <div className="grid max-h-[70vh] grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2 overflow-y-auto p-3">
          {filteredAvatars.length === 0 && (
            <div className="text-fg-muted col-span-full p-4 text-center text-xs">
              No avatars match the current filters.
            </div>
          )}
          {filteredAvatars.map((a) => {
            const active = selectedAvatar?.id === a.id;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => setSelectedAvatar(a)}
                className={cn(
                  'group relative flex flex-col items-stretch overflow-hidden rounded-sm border text-left transition-colors',
                  active
                    ? 'border-[color:var(--accent-amber)] ring-1 ring-[color:var(--accent-amber)]'
                    : 'border-border hover:border-fg-muted',
                )}
                title={`${a.name} · ${a.gender} · ${a.ageBucket} · ${a.ethnicity}`}
              >
                <img
                  src={a.thumbnailUrl}
                  alt={a.name}
                  className="bg-bg-inset aspect-square w-full object-cover"
                />
                <div className="bg-bg-surface flex flex-col gap-0.5 border-t p-1.5">
                  <p className="text-fg truncate text-[10px] font-medium">{a.name}</p>
                  <p className="text-fg-subtle truncate text-[10px]">
                    {a.gender[0]}·{a.ageBucket}·{a.ethnicity[0]}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* PANE 2 — script + voice + submit */}
      <section className="bg-bg-surface flex flex-col gap-3 rounded-sm border p-3">
        <div>
          <p className="text-fg-subtle mb-1 text-[10px] font-semibold uppercase tracking-wider">
            Picked avatar
          </p>
          {selectedAvatar ? (
            <div className="flex items-center gap-2">
              <img
                src={selectedAvatar.thumbnailUrl}
                alt=""
                className="bg-bg-inset h-10 w-10 rounded object-cover"
              />
              <div className="min-w-0 text-xs">
                <p className="text-fg truncate font-medium">{selectedAvatar.name}</p>
                <p className="text-fg-muted truncate">
                  {selectedAvatar.gender} · {selectedAvatar.ageBucket} · {selectedAvatar.ethnicity}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-fg-muted text-xs">Pick one from the grid on the left.</p>
          )}
        </div>

        <div>
          <label
            htmlFor="raw-ugc-script"
            className="text-fg-subtle mb-1 block text-[10px] font-semibold uppercase tracking-wider"
          >
            Script
          </label>
          <textarea
            id="raw-ugc-script"
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={10}
            placeholder="Paste the voice script. Max ~1500 chars per MakeUGC limit."
            className="bg-bg-inset text-fg placeholder:text-fg-subtle w-full rounded-sm border px-2 py-1.5 text-xs leading-snug"
            disabled={busy}
          />
          <p className="text-fg-subtle mt-0.5 text-[10px]">{script.length} / 1500 chars</p>
        </div>

        <div>
          <label
            htmlFor="raw-ugc-voice"
            className="text-fg-subtle mb-1 block text-[10px] font-semibold uppercase tracking-wider"
          >
            Voice (optional)
          </label>
          <select
            id="raw-ugc-voice"
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value)}
            disabled={busy || !selectedAvatar || voicesLoading}
            className="bg-bg-inset text-fg h-8 w-full rounded-sm border px-2 text-xs disabled:opacity-50"
          >
            <option value="">
              {voicesLoading ? 'Loading voices…' : "Use avatar's default voice"}
            </option>
            {voices?.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.language ? ` · ${v.language}` : ''}
                {v.gender ? ` · ${v.gender}` : ''}
                {v.accent ? ` · ${v.accent}` : ''}
              </option>
            ))}
          </select>
        </div>

        <Button
          type="button"
          variant="accent"
          size="lg"
          onClick={handleSubmit}
          disabled={busy || !selectedAvatar || !script.trim() || script.length > 1500}
        >
          {status.kind === 'submitting'
            ? 'Submitting…'
            : status.kind === 'polling'
              ? `Generating (${status.attempts + 1}/${MAX_POLL_ATTEMPTS})…`
              : status.kind === 'processing_timeout'
                ? 'Still generating on MakeUGC…'
                : 'Generate video'}
        </Button>
        <p className="text-fg-subtle text-[10px]">
          Uses MAKEUGC_MANAGED_KEY. Video URL comes back from MakeUGC&apos;s CDN — download + use
          externally. Nothing persisted to the app database.
        </p>
      </section>

      {/* PANE 3 — status / preview */}
      <section className="bg-bg-surface flex flex-col gap-3 rounded-sm border p-3">
        <p className="text-fg-subtle text-[10px] font-semibold uppercase tracking-wider">Result</p>
        {status.kind === 'idle' && (
          <p className="text-fg-muted text-xs">
            No generation in flight. Pick + submit to see the preview here.
          </p>
        )}
        {status.kind === 'submitting' && (
          <p className="text-fg-muted text-xs">Submitting to MakeUGC…</p>
        )}
        {status.kind === 'polling' && (
          <div className="space-y-2 text-xs">
            <p className="text-fg">
              Processing on MakeUGC. Poll {status.attempts + 1} / {MAX_POLL_ATTEMPTS}.
            </p>
            <p className="text-fg-subtle font-mono text-[10px]">videoId: {status.videoId}</p>
            <div className="bg-bg-inset relative h-1 w-full overflow-hidden rounded-sm">
              <div
                className="absolute inset-y-0 left-0 bg-[color:var(--accent-amber)] transition-all"
                style={{ width: `${((status.attempts + 1) / MAX_POLL_ATTEMPTS) * 100}%` }}
              />
            </div>
            <p className="text-fg-subtle text-[10px]">
              Videos usually complete in 30-90s. If MakeUGC&apos;s queue is backed up they can take
              up to ~10 min. If this hits the poll cap you&apos;ll see a &ldquo;still
              generating&rdquo; panel with a Recheck button — credit is already charged and the
              video finishes eventually.
            </p>
          </div>
        )}
        {status.kind === 'processing_timeout' && (
          <div className="space-y-2 text-xs">
            <p className="text-fg font-medium">Still generating on MakeUGC.</p>
            <p className="text-fg-muted leading-snug">
              We polled {MAX_POLL_ATTEMPTS} times (
              {Math.round((MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 60_000)} min) and the video is
              still processing. Credit is already charged — the render will land on MakeUGC
              eventually. Come back in a few minutes and hit Recheck, or open the MakeUGC dashboard
              to watch it directly.
            </p>
            <p className="text-fg-subtle font-mono text-[10px]">videoId: {status.videoId}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="accent"
                size="sm"
                disabled={status.rechecking}
                onClick={() => recheckStatus(status.videoId)}
              >
                {status.rechecking ? 'Rechecking…' : 'Recheck status'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setStatus({ kind: 'idle' })}
              >
                Dismiss
              </Button>
            </div>
          </div>
        )}
        {status.kind === 'done' && (
          <div className="space-y-3">
            <video src={status.url} controls playsInline className="w-full rounded-sm bg-black" />
            <div className="flex flex-col gap-2">
              <a
                href={status.url}
                download
                target="_blank"
                rel="noopener noreferrer"
                className="border-fg/30 hover:bg-bg-surfaceHover text-fg inline-flex items-center justify-center gap-1.5 rounded-sm border px-3 py-1.5 text-xs font-medium"
              >
                <Download className="h-3 w-3" />
                Download mp4
              </a>
              <p className="text-fg-subtle break-all font-mono text-[10px]">
                <a
                  href={status.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-fg underline-offset-2 hover:underline"
                >
                  {status.url}
                </a>
              </p>
              <p className="text-fg-subtle text-[10px]">videoId: {status.videoId}</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setStatus({ kind: 'idle' });
                  setScript('');
                }}
              >
                New generation
              </Button>
            </div>
          </div>
        )}
        {status.kind === 'error' && (
          <div className="space-y-2 text-xs">
            <p className="font-medium text-[color:var(--accent-negative)]">Error</p>
            <p className="text-fg-muted whitespace-pre-wrap">{status.message}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setStatus({ kind: 'idle' })}
            >
              Reset
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

function FilterChip({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-bg-inset text-fg-muted h-7 rounded-sm border px-2 text-xs"
      aria-label={label}
    >
      <option value="">{label}: any</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
