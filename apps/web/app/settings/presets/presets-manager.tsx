'use client';

import * as React from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { LaunchPresetInputSchema, type LaunchPresetInput } from '@mbb/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  createPresetAction,
  deletePresetAction,
  updatePresetAction,
  type PresetRow,
} from './actions';

interface Props {
  initial: PresetRow[];
  optimizationGoals: string[];
  placementTypes: string[];
}

interface EditingState {
  mode: 'create' | 'edit';
  preset?: PresetRow;
}

const EMPTY_FORM: LaunchPresetInput = {
  name: '',
  targetingCountries: ['US'],
  ageMin: 18,
  ageMax: 65,
  optimizationGoal: 'CONVERSIONS',
  placementType: 'advantage_plus',
  perAdDailyBudgetUsd: 10,
};

export function PresetsManager({ initial, optimizationGoals, placementTypes }: Props) {
  const [presets, setPresets] = React.useState<PresetRow[]>(initial);
  const [editing, setEditing] = React.useState<EditingState | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);

  async function onDelete(id: string) {
    if (!confirm('Delete this preset?')) return;
    setPendingDelete(id);
    const result = await deletePresetAction(id);
    setPendingDelete(null);
    if (result.ok) {
      setPresets((prev) => prev.filter((p) => p.id !== id));
    } else {
      alert(result.errorMessage ?? 'Could not delete preset.');
    }
  }

  function onCreated(row: PresetRow) {
    setPresets((prev) => [...prev, row].sort((a, b) => a.name.localeCompare(b.name)));
    setEditing(null);
  }

  function onUpdated(row: PresetRow) {
    setPresets((prev) =>
      prev.map((p) => (p.id === row.id ? row : p)).sort((a, b) => a.name.localeCompare(b.name)),
    );
    setEditing(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="accent"
          size="sm"
          onClick={() => setEditing({ mode: 'create' })}
          disabled={editing !== null}
        >
          <Plus className="mr-1 h-4 w-4" aria-hidden />
          New preset
        </Button>
      </div>

      {presets.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No presets yet.</CardTitle>
          </CardHeader>
          <CardContent className="text-fg-muted text-sm">
            Create a preset to save one launch configuration and re-apply it later without re-
            typing the countries, age range, budget, and optimization goal.
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-3">
          {presets.map((p) => (
            <li key={p.id}>
              <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                  <div>
                    <CardTitle className="text-base">{p.name}</CardTitle>
                    <p className="text-fg-muted mt-1 text-xs">
                      {p.targetingCountries.join(', ')} · Age {p.ageMin}–{p.ageMax} ·{' '}
                      {p.optimizationGoal} · {p.placementType} · ${p.perAdDailyBudgetUsd.toFixed(2)}
                      /day
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setEditing({ mode: 'edit', preset: p })}
                      disabled={editing !== null || pendingDelete !== null}
                    >
                      <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden />
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="text-destructive"
                      onClick={() => onDelete(p.id)}
                      disabled={pendingDelete === p.id}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden />
                      {pendingDelete === p.id ? 'Deleting…' : 'Delete'}
                    </Button>
                  </div>
                </CardHeader>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <PresetDialog
          state={editing}
          optimizationGoals={optimizationGoals}
          placementTypes={placementTypes}
          onClose={() => setEditing(null)}
          onCreated={onCreated}
          onUpdated={onUpdated}
        />
      )}
    </div>
  );
}

interface DialogProps {
  state: EditingState;
  optimizationGoals: string[];
  placementTypes: string[];
  onClose: () => void;
  onCreated: (row: PresetRow) => void;
  onUpdated: (row: PresetRow) => void;
}

function PresetDialog({
  state,
  optimizationGoals,
  placementTypes,
  onClose,
  onCreated,
  onUpdated,
}: DialogProps) {
  const isEdit = state.mode === 'edit' && state.preset;
  const initial: LaunchPresetInput = isEdit
    ? {
        name: state.preset!.name,
        targetingCountries: state.preset!.targetingCountries,
        ageMin: state.preset!.ageMin,
        ageMax: state.preset!.ageMax,
        optimizationGoal: state.preset!.optimizationGoal as LaunchPresetInput['optimizationGoal'],
        placementType: state.preset!.placementType as LaunchPresetInput['placementType'],
        perAdDailyBudgetUsd: state.preset!.perAdDailyBudgetUsd,
      }
    : EMPTY_FORM;

  const [form, setForm] = React.useState<LaunchPresetInput>(initial);
  const [countriesText, setCountriesText] = React.useState(form.targetingCountries.join(', '));
  const [errors, setErrors] = React.useState<Partial<Record<keyof LaunchPresetInput, string>>>({});
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setErrors({});
    const countries = countriesText
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    const candidate = { ...form, targetingCountries: countries };
    const parsed = LaunchPresetInputSchema.safeParse(candidate);
    if (!parsed.success) {
      const fieldErrors: Partial<Record<keyof LaunchPresetInput, string>> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path[0] as keyof LaunchPresetInput | undefined;
        if (path && !fieldErrors[path]) fieldErrors[path] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }
    setSubmitting(true);
    try {
      if (isEdit) {
        const result = await updatePresetAction(state.preset!.id, parsed.data);
        if (!result.ok) {
          setError(result.errorMessage ?? 'Could not save preset.');
          if (result.fieldErrors) setErrors(result.fieldErrors);
          return;
        }
        onUpdated({
          id: state.preset!.id,
          name: parsed.data.name,
          targetingCountries: parsed.data.targetingCountries,
          ageMin: parsed.data.ageMin,
          ageMax: parsed.data.ageMax,
          optimizationGoal: parsed.data.optimizationGoal,
          placementType: parsed.data.placementType,
          perAdDailyBudgetUsd: parsed.data.perAdDailyBudgetUsd,
        });
      } else {
        const result = await createPresetAction(parsed.data);
        if (!result.ok || !result.presetId) {
          setError(result.errorMessage ?? 'Could not create preset.');
          if (result.fieldErrors) setErrors(result.fieldErrors);
          return;
        }
        onCreated({
          id: result.presetId,
          name: parsed.data.name,
          targetingCountries: parsed.data.targetingCountries,
          ageMin: parsed.data.ageMin,
          ageMax: parsed.data.ageMax,
          optimizationGoal: parsed.data.optimizationGoal,
          placementType: parsed.data.placementType,
          perAdDailyBudgetUsd: parsed.data.perAdDailyBudgetUsd,
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit preset' : 'New preset'}</DialogTitle>
          <DialogDescription>
            Saves the launch settings under a name so you can pick it from the launch dialog.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <Label htmlFor="preset-name">Preset name</Label>
            <Input
              id="preset-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="US cold — $20/day"
              maxLength={60}
              autoFocus
            />
            {errors.name && <p className="text-destructive mt-1 text-xs">{errors.name}</p>}
          </div>

          <div>
            <Label htmlFor="preset-countries">Countries (2-letter codes, comma-separated)</Label>
            <Input
              id="preset-countries"
              value={countriesText}
              onChange={(e) => setCountriesText(e.target.value)}
              placeholder="US, CA, GB"
            />
            {errors.targetingCountries && (
              <p className="text-destructive mt-1 text-xs">{errors.targetingCountries}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="preset-age-min">Min age</Label>
              <Input
                id="preset-age-min"
                type="number"
                min={13}
                max={65}
                value={form.ageMin}
                onChange={(e) => setForm({ ...form, ageMin: Number(e.target.value) || 13 })}
              />
              {errors.ageMin && <p className="text-destructive mt-1 text-xs">{errors.ageMin}</p>}
            </div>
            <div>
              <Label htmlFor="preset-age-max">Max age</Label>
              <Input
                id="preset-age-max"
                type="number"
                min={13}
                max={65}
                value={form.ageMax}
                onChange={(e) => setForm({ ...form, ageMax: Number(e.target.value) || 65 })}
              />
              {errors.ageMax && <p className="text-destructive mt-1 text-xs">{errors.ageMax}</p>}
            </div>
          </div>

          <div>
            <Label htmlFor="preset-goal">Optimization goal</Label>
            <select
              id="preset-goal"
              value={form.optimizationGoal}
              onChange={(e) =>
                setForm({
                  ...form,
                  optimizationGoal: e.target.value as typeof form.optimizationGoal,
                })
              }
              className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
            >
              {optimizationGoals.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="preset-placement">Placement type</Label>
            <select
              id="preset-placement"
              value={form.placementType}
              onChange={(e) =>
                setForm({ ...form, placementType: e.target.value as typeof form.placementType })
              }
              className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
            >
              {placementTypes.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="preset-budget">Per-ad daily budget (USD)</Label>
            <Input
              id="preset-budget"
              type="number"
              min={0.01}
              step={0.01}
              value={form.perAdDailyBudgetUsd}
              onChange={(e) =>
                setForm({
                  ...form,
                  perAdDailyBudgetUsd: Number(e.target.value) || 0,
                })
              }
            />
            {errors.perAdDailyBudgetUsd && (
              <p className="text-destructive mt-1 text-xs">{errors.perAdDailyBudgetUsd}</p>
            )}
          </div>

          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={submitting}>
              {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create preset'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
