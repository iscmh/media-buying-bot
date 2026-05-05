'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { NICHE_TAGS_LIST, SOURCE_PLATFORMS_LIST } from '@mbb/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { createConceptAction } from './actions';

export function ConceptUploadTabs() {
  return (
    <Tabs defaultValue="static" className="w-full">
      <TabsList>
        <TabsTrigger value="static">Static (image + copy)</TabsTrigger>
        <TabsTrigger value="ugc">UGC video</TabsTrigger>
      </TabsList>
      <TabsContent value="static">
        <ConceptUploadForm contentType="static" />
      </TabsContent>
      <TabsContent value="ugc">
        <ConceptUploadForm contentType="ugc" />
      </TabsContent>
    </Tabs>
  );
}

function ConceptUploadForm({ contentType }: { contentType: 'static' | 'ugc' }) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const formRef = React.useRef<HTMLFormElement>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!formRef.current) return;
    const formData = new FormData(formRef.current);
    formData.set('contentType', contentType);
    startTransition(async () => {
      setError(null);
      const result = await createConceptAction(formData);
      if (!result.ok || !result.conceptId) {
        setError(result.errorMessage ?? 'Upload failed.');
        return;
      }
      router.push(`/concepts/${result.conceptId}`);
    });
  }

  const accept =
    contentType === 'static' ? 'image/png,image/jpeg,image/webp' : 'video/mp4,video/quicktime';
  const maxLabel = contentType === 'static' ? '10 MB' : '100 MB';

  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-5 pt-4">
      <div className="space-y-1.5">
        <Label htmlFor="file">{contentType === 'static' ? 'Image' : 'Video'}</Label>
        <Input
          id="file"
          name="file"
          type="file"
          accept={accept}
          required
          className="file:bg-muted file:mr-3 file:rounded file:border-0 file:px-3 file:py-1 file:text-sm"
        />
        <p className="text-muted-foreground text-xs">Max {maxLabel}.</p>
      </div>

      {contentType === 'static' && (
        <>
          <FormField name="staticHeadline" label="Headline" required maxLength={200} />
          <FormField
            name="staticPrimaryText"
            label="Primary text"
            required
            textarea
            maxLength={2000}
          />
          <FormField name="staticDescription" label="Description (optional)" maxLength={500} />
        </>
      )}
      {contentType === 'ugc' && (
        <FormField
          name="ugcOriginalScript"
          label="Original script (optional)"
          textarea
          maxLength={4000}
          help="If you have it — speeds up generation."
        />
      )}

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <SelectField name="nicheTag" label="Niche" options={NICHE_TAGS_LIST} />
        <SelectField
          name="sourcePlatform"
          label="Source platform"
          options={SOURCE_PLATFORMS_LIST}
        />
      </fieldset>

      <FormField name="offerUrl" label="Offer URL (optional)" type="url" />
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <FormField
          name="originalCpaUsd"
          label="Original CPA (USD, optional)"
          type="number"
          step="0.01"
        />
        <FormField name="originalRoas" label="Original ROAS (optional)" type="number" step="0.01" />
      </fieldset>

      <FormField name="description" label="Notes (optional)" textarea maxLength={2000} />

      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}

      <Button type="submit" size="lg" disabled={pending}>
        {pending ? 'Uploading…' : 'Save concept'}
      </Button>
    </form>
  );
}

interface FieldProps {
  name: string;
  label: string;
  required?: boolean;
  textarea?: boolean;
  type?: string;
  step?: string;
  maxLength?: number;
  help?: string;
}

function FormField({ name, label, required, textarea, type, step, maxLength, help }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      {textarea ? (
        <textarea
          id={name}
          name={name}
          required={required}
          maxLength={maxLength}
          rows={3}
          className="border-input bg-background min-h-[80px] w-full rounded-md border px-3 py-2 text-sm"
        />
      ) : (
        <Input
          id={name}
          name={name}
          type={type ?? 'text'}
          step={step}
          required={required}
          maxLength={maxLength}
        />
      )}
      {help && <p className="text-muted-foreground text-xs">{help}</p>}
    </div>
  );
}

interface SelectFieldProps {
  name: string;
  label: string;
  options: readonly string[];
}

function SelectField({ name, label, options }: SelectFieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      <select
        id={name}
        name={name}
        defaultValue=""
        className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}
