import { AlertCircle, CheckCircle2, CircleDashed, Loader2 } from 'lucide-react';
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

  if (conceptType === 'static') {
    return [
      {
        id: 'submitted',
        label: 'Job submitted',
        status: 'completed',
        at: requestedIso,
        detail: job.providerChoice ?? 'gemini+claude',
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

  // UGC flow.
  return [
    {
      id: 'submitted',
      label: 'Job submitted',
      status: 'completed',
      at: requestedIso,
      detail: job.providerChoice ?? 'heygen',
    },
    {
      id: 'analyze',
      label: hasAnalysis ? 'Source analyzed' : 'Analyzing source',
      status: isFailed && !hasAnalysis ? 'failed' : hasAnalysis ? 'completed' : 'running',
    },
    {
      id: 'scripts',
      label: hasAnyVariant ? 'Scripts generated' : 'Generating scripts',
      status:
        isFailed && !hasAnyVariant
          ? 'failed'
          : hasAnyVariant
            ? 'completed'
            : hasAnalysis
              ? 'running'
              : 'pending',
    },
    {
      id: 'avatars',
      label: 'Avatars picked',
      // We can't tell precisely from the snapshot — once a variant has
      // any state at all, avatar pick has happened. Use "any variant
      // exists" as a proxy.
      status: hasAnyVariant ? 'completed' : isProcessing && hasAnalysis ? 'running' : 'pending',
    },
    {
      id: 'videos',
      label: written >= expected && expected > 0 ? 'Videos generated' : 'Generating videos',
      status:
        isFailed && written < expected
          ? 'failed'
          : written >= expected && expected > 0
            ? 'completed'
            : hasAnyVariant
              ? 'running'
              : 'pending',
      detail: expected > 0 ? `${written}/${expected} ready` : undefined,
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
