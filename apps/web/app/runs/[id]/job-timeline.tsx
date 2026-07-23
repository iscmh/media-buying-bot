import { AlertCircle, CheckCircle2, CircleDashed, Loader2 } from 'lucide-react';
import { describePipeline, pipelineFromString } from '@mbb/shared';
import { formatDateTime } from '@/lib/format/date';
import { cn } from '@/lib/utils';

type StepStatus = 'pending' | 'running' | 'completed' | 'failed';

interface TimelineStep {
  id: string;
  label: string;
  status: StepStatus;
  /** Optional ISO timestamp for "done at" / "started at". */
  at?: string | null;
  /** Optional secondary line — duration or count. */
  detail?: string;
}

interface Props {
  conceptType: 'static' | 'ugc';
  job: {
    status: string;
    mode: string;
    requestedAt: Date;
    completedAt: Date | null;
    variantCount: number | null;
    providerChoice: string | null;
    // Polish-25.3 Commit 18a: pass through the picked pipeline so
    // the timeline can render a friendly descriptor label instead
    // of the raw providerChoice enum. Optional so legacy jobs
    // (pre-descriptor era) still render.
    pickedPipeline: string | null;
    errorMessage: string | null;
    metadata: unknown;
  };
  variants: Array<{
    id: string;
    status: string;
    fileUrl: string | null;
    createdAtIso: string;
  }>;
}

/**
 * Polish-25.3 Commit 18a: map job.pickedPipeline → user-facing
 * label using the shared descriptor table. Prevents raw enum
 * strings like `makeugc`, `openai`, `gemini`, `heygen` from
 * bleeding into the "Job submitted · X" detail line on the
 * timeline (operator report from Commit 17 walkthrough: "Job
 * submitted · makeugc" surfaced on every Polish-25 job).
 *
 * Returns null when the pipeline is unknown so the caller can
 * skip rendering rather than leak a raw code path. Also returns
 * null when the descriptor's label is one of the "internal-
 * looking" ones we don't want on the top-of-page timeline
 * (e.g. legacy Nano Banana / Sora surfacing on old rows).
 */
function friendlyPipelineLabel(pickedPipeline: string | null): string | null {
  const pipeline = pipelineFromString(pickedPipeline);
  if (!pipeline) return null;
  return describePipeline(pipeline).label;
}

/**
 * Vertical timeline of pipeline steps, derived from the job snapshot +
 * variants. We don't read Inngest step state directly — the job row
 * tells us enough to map a coarse status per step.
 *
 * Step set differs per content type:
 *   - static: Submitted → Generating → Completed
 *   - ugc:    Submitted → Analyzing source → Generating scripts →
 *             Picking avatars → Generating videos → Completed
 */
export function JobTimeline({ conceptType, job, variants }: Props) {
  const steps: TimelineStep[] = deriveSteps(conceptType, job, variants);

  return (
    <div className="bg-bg-elevated rounded-md border p-4">
      <h2 className="text-fg mb-4 text-sm font-semibold">Pipeline</h2>
      <ol className="space-y-0">
        {steps.map((step, i) => (
          <TimelineRow key={step.id} step={step} isLast={i === steps.length - 1} />
        ))}
      </ol>
    </div>
  );
}

function TimelineRow({ step, isLast }: { step: TimelineStep; isLast: boolean }) {
  const Icon =
    step.status === 'completed'
      ? CheckCircle2
      : step.status === 'failed'
        ? AlertCircle
        : step.status === 'running'
          ? Loader2
          : CircleDashed;

  const iconColor =
    step.status === 'completed'
      ? 'text-success'
      : step.status === 'failed'
        ? 'text-[color:var(--destructive-color)]'
        : step.status === 'running'
          ? 'text-fg'
          : 'text-fg-subtle';

  const isRunning = step.status === 'running';
  return (
    <li className="flex gap-3 pb-3 last:pb-0">
      <div className="flex flex-col items-center">
        <div className="flex h-5 items-center">
          <Icon className={cn('h-4 w-4', iconColor, isRunning && 'animate-spin')} />
        </div>
        {!isLast && (
          <div
            className={cn(
              'mt-1 w-px flex-1',
              step.status === 'completed' ? 'bg-success/30' : 'bg-border',
            )}
          />
        )}
      </div>
      {/* Polish-25.2 Commit 16a: running row now gets a subtle inset
          background + a pulsing "in progress" dot so it reads as
          "this is happening right now" even on a static screenshot
          (walkthrough finding: users assumed the page had frozen when
          scripts step ran for 30s). */}
      <div
        className={cn(
          'min-w-0 flex-1 pb-2',
          isRunning && 'bg-bg-inset/50 -my-1 -ml-2 rounded-md px-2 py-1',
        )}
      >
        <p
          className={cn(
            'flex items-center gap-2 text-sm',
            step.status === 'pending' ? 'text-fg-subtle' : 'text-fg',
            isRunning && 'font-medium',
          )}
        >
          <span>{step.label}</span>
          {isRunning && (
            <span
              aria-hidden
              className="bg-fg/60 inline-block h-1.5 w-1.5 animate-pulse rounded-full"
            />
          )}
        </p>
        <div className="text-fg-muted font-mono text-xs">
          {step.at && <span>{formatDateTime(new Date(step.at))}</span>}
          {step.at && step.detail && <span> · </span>}
          {step.detail && <span>{step.detail}</span>}
          {isRunning && !step.at && !step.detail && <span>in progress…</span>}
        </div>
      </div>
    </li>
  );
}

function deriveSteps(
  conceptType: 'static' | 'ugc',
  job: Props['job'],
  variants: Props['variants'],
): TimelineStep[] {
  const requestedIso = job.requestedAt.toISOString();
  const completedIso = job.completedAt?.toISOString() ?? null;
  const isFailed = job.status === 'failed';
  const isDone = job.status === 'completed';
  const isProcessing = job.status === 'processing' || job.status === 'queued';

  // Variant rollup: count those with a fileUrl as written, the rest as
  // pending/in-flight. Rejected counts as terminal (the variant errored
  // but the job moved on).
  const written = variants.filter((v) => v.fileUrl && v.fileUrl.length > 0).length;
  const expected = job.variantCount ?? variants.length;
  const hasAnalysis =
    job.metadata !== null && job.metadata !== undefined && typeof job.metadata === 'object';
  const hasAnyVariant = variants.length > 0;

  // Polish-25.2 Commit 17: read metadata.polish25_progress.step
  // written by generate-polish25-makeugc's step.run() boundaries.
  // Before Commit 17 the UGC timeline derived state from
  // { hasAnalysis, hasAnyVariant } only, which is wrong once the
  // worker starts writing metadata: metadata goes non-null on the
  // very first step (mark-processing), flipping "Source analyzed"
  // to complete AND "Scripts" + "Avatars" both to running for the
  // entire remaining runtime. The persisted step string is the
  // real source of truth. Strings the worker emits:
  //   mark-processing → source-context → script-condensed →
  //   avatar-matched → submitted → video-ready
  const polish25Step: string | null =
    job.metadata &&
    typeof job.metadata === 'object' &&
    'polish25_progress' in (job.metadata as Record<string, unknown>) &&
    typeof (job.metadata as Record<string, unknown>)['polish25_progress'] === 'object' &&
    (job.metadata as Record<string, unknown>)['polish25_progress'] !== null &&
    'step' in
      ((job.metadata as Record<string, Record<string, unknown>>)['polish25_progress'] as Record<
        string,
        unknown
      >)
      ? String(
          (job.metadata as Record<string, Record<string, unknown>>)['polish25_progress']!['step'],
        )
      : null;

  // Polish-25.3 Commit 18a: resolve the friendly label ONCE per
  // deriveSteps call so both static + UGC branches use the same
  // logic and neither leaks a raw enum. `label ?? undefined`
  // pattern hides the detail line entirely when the pipeline
  // can't be resolved (legacy pre-descriptor rows).
  const submittedDetail = friendlyPipelineLabel(job.pickedPipeline) ?? undefined;

  if (conceptType === 'static') {
    return [
      {
        id: 'submitted',
        label: 'Job submitted',
        status: 'completed',
        at: requestedIso,
        detail: submittedDetail,
      },
      {
        id: 'generating',
        label: isDone ? 'Variants generated' : 'Generating variants',
        status: isFailed
          ? 'failed'
          : isDone
            ? 'completed'
            : isProcessing && hasAnyVariant
              ? 'running'
              : isProcessing
                ? 'running'
                : 'pending',
        at: hasAnyVariant ? variants[0]!.createdAtIso : null,
        detail: expected > 0 ? `${written}/${expected} written` : undefined,
      },
      {
        id: 'complete',
        label: isFailed ? 'Failed' : isDone ? 'Completed' : 'Pending completion',
        status: isFailed ? 'failed' : isDone ? 'completed' : 'pending',
        at: completedIso,
        detail: isFailed ? (job.errorMessage ?? undefined) : undefined,
      },
    ];
  }

  // UGC flow. Prefer the worker-persisted step over inferred
  // proxies whenever polish25_progress is present.
  return deriveUgcSteps({
    requestedIso,
    completedIso,
    isFailed,
    isDone,
    isProcessing,
    hasAnalysis,
    hasAnyVariant,
    written,
    expected,
    // Polish-25.3 Commit 18a: pass the resolved friendly label
    // (or undefined) rather than the raw providerChoice enum,
    // so downstream never has an opportunity to leak.
    submittedDetail,
    errorMessage: job.errorMessage,
    polish25Step,
  });
}

interface UgcDeriveInput {
  requestedIso: string;
  completedIso: string | null;
  isFailed: boolean;
  isDone: boolean;
  isProcessing: boolean;
  hasAnalysis: boolean;
  hasAnyVariant: boolean;
  written: number;
  expected: number;
  submittedDetail: string | undefined;
  errorMessage: string | null;
  polish25Step: string | null;
}

/**
 * Rank ordering of Polish-25 worker step names. Every earlier
 * step is `completed`, the matching step is `running`, every
 * later step is `pending`. On job.status === completed, the
 * final "complete" row wins; on failed, whichever step was
 * running gets marked failed.
 *
 * Kept as an ordered list (not a Set) so a future step string
 * from the worker slots in cleanly at the right position.
 */
const POLISH25_STEP_ORDER = [
  'mark-processing',
  'source-context',
  'script-condensed',
  'avatar-matched',
  'submitted',
  'video-ready',
] as const;

/**
 * Map polish25_progress.step → which UGC-timeline row should be
 * marked `running`. Everything before it is `completed`,
 * everything after is `pending`.
 */
const POLISH25_STEP_TO_TIMELINE: Record<(typeof POLISH25_STEP_ORDER)[number], string> = {
  'mark-processing': 'analyze',
  'source-context': 'scripts',
  'script-condensed': 'avatars',
  'avatar-matched': 'videos',
  submitted: 'videos',
  'video-ready': 'complete',
};

function deriveUgcSteps(input: UgcDeriveInput): TimelineStep[] {
  const {
    requestedIso,
    completedIso,
    isFailed,
    isDone,
    isProcessing,
    hasAnalysis,
    hasAnyVariant,
    written,
    expected,
    submittedDetail,
    errorMessage,
    polish25Step,
  } = input;

  // Row order — must match the id sequence downstream depends on
  // for the "everything before running is completed" walk.
  const rowIds = ['submitted', 'analyze', 'scripts', 'avatars', 'videos', 'complete'] as const;
  type RowId = (typeof rowIds)[number];

  // Baseline status per row from polish25_progress when present.
  // When polish25_progress is missing (legacy Polish-23 job or
  // pre-Commit-17 rows) fall back to the old proxy-based logic
  // so those jobs still render coherently.
  const baseline: Record<RowId, StepStatus> = {
    submitted: 'completed',
    analyze: 'pending',
    scripts: 'pending',
    avatars: 'pending',
    videos: 'pending',
    complete: 'pending',
  };

  if (
    polish25Step &&
    (POLISH25_STEP_ORDER as readonly string[]).includes(polish25Step) &&
    polish25Step in POLISH25_STEP_TO_TIMELINE
  ) {
    const runningRow = POLISH25_STEP_TO_TIMELINE[
      polish25Step as (typeof POLISH25_STEP_ORDER)[number]
    ] as RowId;
    let seenRunning = false;
    for (const id of rowIds) {
      if (id === runningRow) {
        baseline[id] = 'running';
        seenRunning = true;
      } else if (!seenRunning) {
        baseline[id] = 'completed';
      }
    }
  } else {
    // Legacy fallback: same shape as pre-Commit-17. Kept so
    // Polish-23 (Veo Lite) jobs + any job predating the worker's
    // progress writes still animate reasonably.
    baseline.analyze = hasAnalysis ? 'completed' : 'running';
    baseline.scripts = hasAnyVariant ? 'completed' : hasAnalysis ? 'running' : 'pending';
    baseline.avatars = hasAnyVariant
      ? 'completed'
      : isProcessing && hasAnalysis
        ? 'running'
        : 'pending';
    baseline.videos =
      written >= expected && expected > 0 ? 'completed' : hasAnyVariant ? 'running' : 'pending';
  }

  // Terminal overrides. isDone flips the final row to completed;
  // isFailed marks the currently-running row (or the final row
  // when no row is running) as failed.
  if (isDone) baseline.complete = 'completed';
  if (isFailed) {
    let stamped = false;
    for (const id of rowIds) {
      if (baseline[id] === 'running') {
        baseline[id] = 'failed';
        stamped = true;
        break;
      }
    }
    if (!stamped) baseline.complete = 'failed';
  }

  const rows: TimelineStep[] = [
    {
      id: 'submitted',
      label: 'Job submitted',
      status: baseline.submitted,
      at: requestedIso,
      detail: submittedDetail,
    },
    {
      id: 'analyze',
      label: baseline.analyze === 'completed' ? 'Source analyzed' : 'Analyzing source',
      status: baseline.analyze,
    },
    {
      id: 'scripts',
      label: baseline.scripts === 'completed' ? 'Scripts generated' : 'Generating scripts',
      status: baseline.scripts,
    },
    {
      id: 'avatars',
      label: baseline.avatars === 'completed' ? 'Avatars picked' : 'Picking avatars',
      status: baseline.avatars,
    },
    {
      id: 'videos',
      label:
        baseline.videos === 'completed'
          ? 'Videos generated'
          : polish25Step === 'submitted'
            ? 'Rendering videos (this is the slow one)'
            : 'Generating videos',
      status: baseline.videos,
      detail: expected > 0 ? `${written}/${expected} ready` : undefined,
    },
    {
      id: 'complete',
      label:
        baseline.complete === 'failed' ? 'Failed' : isDone ? 'Completed' : 'Pending completion',
      status: baseline.complete,
      at: completedIso,
      detail: baseline.complete === 'failed' ? (errorMessage ?? undefined) : undefined,
    },
  ];

  return rows;
}
