'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Pencil, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { renameConceptAction } from '../actions';

interface Props {
  conceptId: string;
  initialName: string;
}

/**
 * Inline-edit display for the concept name on /concepts/[id]. Read mode
 * shows the heading + a small Pencil button; click it to swap in an
 * Input + Save/Cancel. Empty input is rejected by the server action.
 */
export function ConceptNameEdit({ conceptId, initialName }: Props) {
  const router = useRouter();
  const [name, setName] = React.useState(initialName);
  const [editing, setEditing] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function startEdit() {
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setName(initialName);
    setError(null);
    setEditing(false);
  }

  function save() {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('Name cannot be empty.');
      return;
    }
    if (trimmed === initialName) {
      setEditing(false);
      return;
    }
    startTransition(async () => {
      const result = await renameConceptAction({ conceptId, name: trimmed });
      if (!result.ok) {
        setError(result.errorMessage ?? 'Rename failed.');
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }

  if (editing) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Input
            ref={inputRef}
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onKey}
            className="h-9 text-lg"
            disabled={pending}
          />
          <Button
            type="button"
            size="icon"
            onClick={save}
            disabled={pending}
            aria-label="Save name"
          >
            <Check className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={cancel}
            disabled={pending}
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {error && (
          <p className="text-xs text-[color:var(--destructive-color)]" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-2">
      <h1 className="text-fg text-2xl font-semibold tracking-tight">{initialName}</h1>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={startEdit}
        aria-label="Rename concept"
        className="opacity-60 transition-opacity group-hover:opacity-100"
      >
        <Pencil className="h-4 w-4" />
      </Button>
    </div>
  );
}
