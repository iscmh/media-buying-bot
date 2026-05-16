'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { HeyGenAvatar } from '@mbb/ai-providers';
import { Button } from '@/components/ui/button';
import { saveDefaultHeygenAvatarAction } from './heygen-avatar-actions';

interface Props {
  avatars: HeyGenAvatar[];
  currentDefaultId: string | null;
  totalAvailable: number;
}

/**
 * Phase 3f: client-side avatar grid. Optimistic-ish — selecting an
 * avatar fires a server action immediately rather than waiting for a
 * dedicated "Save" button. Failure surfaces inline + reverts UI state.
 */
export function AvatarPickerForm({ avatars, currentDefaultId, totalAvailable }: Props) {
  const router = useRouter();
  const [selectedId, setSelectedId] = React.useState<string | null>(currentDefaultId);
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [savedAtId, setSavedAtId] = React.useState<string | null>(null);

  function pick(id: string) {
    setError(null);
    const previous = selectedId;
    setSelectedId(id);
    startTransition(async () => {
      const fd = new FormData();
      fd.set('avatarId', id);
      const result = await saveDefaultHeygenAvatarAction(fd);
      if (!result.ok) {
        setError(result.errorMessage ?? 'Could not save avatar.');
        setSelectedId(previous);
        return;
      }
      setSavedAtId(id);
      router.refresh();
    });
  }

  if (avatars.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Your HeyGen account has no avatars yet. Create or unlock one at{' '}
        <a
          className="underline"
          href="https://app.heygen.com/avatars"
          target="_blank"
          rel="noopener noreferrer"
        >
          app.heygen.com/avatars
        </a>
        .
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {avatars.map((avatar) => {
          const isSelected = selectedId === avatar.avatar_id;
          return (
            <button
              type="button"
              key={avatar.avatar_id}
              onClick={() => pick(avatar.avatar_id)}
              disabled={pending && selectedId !== avatar.avatar_id}
              aria-pressed={isSelected}
              className={
                'bg-card group relative overflow-hidden rounded-lg border text-left transition ' +
                (isSelected
                  ? 'border-primary ring-primary/30 ring-2'
                  : 'hover:border-muted-foreground/40')
              }
            >
              {avatar.preview_image_url ? (
                <img
                  src={avatar.preview_image_url}
                  alt={avatar.avatar_name}
                  className="aspect-square w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="bg-muted text-muted-foreground flex aspect-square w-full items-center justify-center text-xs">
                  No preview
                </div>
              )}
              <div className="space-y-0.5 p-2 text-xs">
                <p className="line-clamp-1 font-medium">{avatar.avatar_name}</p>
                {avatar.gender && (
                  <p className="text-muted-foreground capitalize">{avatar.gender}</p>
                )}
              </div>
              {isSelected && (
                <span className="bg-primary text-primary-foreground absolute right-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-medium">
                  Default
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <p className="text-muted-foreground">
          Showing {avatars.length} of {totalAvailable}.{' '}
          <a
            className="underline"
            href="https://app.heygen.com/avatars"
            target="_blank"
            rel="noopener noreferrer"
          >
            Browse the full catalog on HeyGen ↗
          </a>
        </p>
        {selectedId && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => pick('')}
          >
            Clear default
          </Button>
        )}
      </div>

      {savedAtId && !error && !pending && <p className="text-xs text-emerald-700">Saved.</p>}
      {error && (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
