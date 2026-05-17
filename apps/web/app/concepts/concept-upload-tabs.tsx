'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { FileVideo, ImageIcon, Upload, X } from 'lucide-react';
import { NICHE_TAGS_LIST, SOURCE_PLATFORMS_LIST } from '@mbb/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { createConceptAction } from './actions';

export function ConceptUploadTabs() {
  return (
    <Tabs defaultValue="static" className="w-full">
      <TabsList className="bg-bg-elevated h-9">
        <TabsTrigger
          value="static"
          className="data-[state=active]:bg-bg-active data-[state=active]:text-fg text-fg-muted data-[state=active]:shadow-none"
        >
          Static (image + copy)
        </TabsTrigger>
        <TabsTrigger
          value="ugc"
          className="data-[state=active]:bg-bg-active data-[state=active]:text-fg text-fg-muted data-[state=active]:shadow-none"
        >
          UGC video
        </TabsTrigger>
      </TabsList>
      <TabsContent value="static" className="mt-4">
        <ConceptUploadForm contentType="static" />
      </TabsContent>
      <TabsContent value="ugc" className="mt-4">
        <ConceptUploadForm contentType="ugc" />
      </TabsContent>
    </Tabs>
  );
}

function ConceptUploadForm({ contentType }: { contentType: 'static' | 'ugc' }) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [file, setFile] = React.useState<File | null>(null);
  const [name, setName] = React.useState<string>('');
  const [niche, setNiche] = React.useState<string>('');
  const [platform, setPlatform] = React.useState<string>('');
  const formRef = React.useRef<HTMLFormElement>(null);

  // Auto-fill the name from the filename on first pick. If the user
  // typed something custom, we don't overwrite.
  function handleFileChange(next: File | null) {
    setFile(next);
    if (next && name.trim().length === 0) {
      setName(stripExtension(next.name));
    }
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!formRef.current) return;
    if (!file) {
      setError(`Pick ${contentType === 'static' ? 'an image' : 'a video'} first.`);
      return;
    }
    const formData = new FormData(formRef.current);
    formData.set('contentType', contentType);
    formData.set('file', file);
    if (name.trim().length > 0) formData.set('name', name.trim());
    if (niche) formData.set('nicheTag', niche);
    if (platform) formData.set('sourcePlatform', platform);
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
    <form ref={formRef} onSubmit={onSubmit} className="space-y-6">
      <Dropzone
        contentType={contentType}
        accept={accept}
        maxLabel={maxLabel}
        file={file}
        onFileChange={handleFileChange}
      />

      <div className="space-y-1.5">
        <Label htmlFor="name">Concept name</Label>
        <Input
          id="name"
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          placeholder="Defaults to the uploaded filename"
        />
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

      {/* Niche + Source platform side by side on md+. */}
      <div className="grid gap-4 md:grid-cols-2">
        <SelectField
          name="nicheTag"
          label="Niche"
          options={NICHE_TAGS_LIST}
          value={niche}
          onChange={setNiche}
          placeholder="Pick a niche"
        />
        <SelectField
          name="sourcePlatform"
          label="Source platform"
          options={SOURCE_PLATFORMS_LIST}
          value={platform}
          onChange={setPlatform}
          placeholder="Where it ran"
        />
      </div>

      <FormField name="offerUrl" label="Offer URL (optional)" type="url" />

      {/* Original CPA + Original ROAS side by side on md+. */}
      <div className="grid gap-4 md:grid-cols-2">
        <FormField
          name="originalCpaUsd"
          label="Original CPA (USD, optional)"
          type="number"
          step="0.01"
          mono
        />
        <FormField
          name="originalRoas"
          label="Original ROAS (optional)"
          type="number"
          step="0.01"
          mono
        />
      </div>

      <FormField name="description" label="Notes (optional)" textarea maxLength={2000} />

      {error && (
        <p className="text-sm text-[color:var(--destructive-color)]" role="alert">
          {error}
        </p>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? 'Uploading…' : 'Save concept'}
        </Button>
      </div>
    </form>
  );
}

interface DropzoneProps {
  contentType: 'static' | 'ugc';
  accept: string;
  maxLabel: string;
  file: File | null;
  onFileChange: (file: File | null) => void;
}

/**
 * Custom drag-and-drop file picker. Dashed border + lucide icon + copy
 * directing the user to drop or click. Once a file is picked, swaps to
 * a "chosen file" pill with size + clear button. The native input lives
 * underneath, opacity-0 so it remains keyboard-focusable.
 */
function Dropzone({ contentType, accept, maxLabel, file, onFileChange }: DropzoneProps) {
  const [isDragging, setIsDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const Icon = contentType === 'static' ? ImageIcon : FileVideo;

  function handleDrop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) {
      onFileChange(dropped);
      // Sync the underlying input so native form-validation messaging
      // (required) reflects the dropped file.
      if (inputRef.current) {
        const dt = new DataTransfer();
        dt.items.add(dropped);
        inputRef.current.files = dt.files;
      }
    }
  }

  if (file) {
    return (
      <div className="border-border bg-bg-elevated flex items-center justify-between gap-3 rounded-md border p-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="bg-bg-active text-fg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-fg truncate text-sm font-medium">{file.name}</p>
            <p className="text-fg-muted font-mono text-xs">
              {(file.size / (1024 * 1024)).toFixed(2)} MB
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => {
            onFileChange(null);
            if (inputRef.current) inputRef.current.value = '';
          }}
          aria-label="Remove file"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <label
      htmlFor="file"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      className={cn(
        'border-border bg-bg-elevated/40 hover:border-fg-subtle flex cursor-pointer flex-col items-center justify-center gap-3 rounded-md border border-dashed px-6 py-10 text-center transition-colors',
        isDragging && 'border-fg-muted bg-bg-elevated',
      )}
    >
      <div className="bg-bg-active text-fg-muted flex h-10 w-10 items-center justify-center rounded-md">
        <Upload className="h-5 w-5" />
      </div>
      <div className="space-y-0.5">
        <p className="text-fg text-sm font-medium">
          Drop your {contentType === 'static' ? 'image' : 'video'} here or click to browse
        </p>
        <p className="text-fg-muted text-xs">
          {contentType === 'static' ? 'PNG, JPEG, or WEBP' : 'MP4 or MOV'} · max {maxLabel}
        </p>
      </div>
      <input
        ref={inputRef}
        id="file"
        name="file"
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
      />
    </label>
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
  mono?: boolean;
}

function FormField({
  name,
  label,
  required,
  textarea,
  type,
  step,
  maxLength,
  help,
  mono,
}: FieldProps) {
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
          className="border-input bg-bg-elevated text-fg placeholder:text-fg-subtle focus:ring-ring min-h-[80px] w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-offset-1"
        />
      ) : (
        <Input
          id={name}
          name={name}
          type={type ?? 'text'}
          step={step}
          required={required}
          maxLength={maxLength}
          className={mono ? 'font-mono' : undefined}
        />
      )}
      {help && <p className="text-fg-muted text-xs">{help}</p>}
    </div>
  );
}

interface SelectFieldProps {
  name: string;
  label: string;
  options: readonly string[];
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}

function stripExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  const base = idx > 0 ? filename.slice(0, idx) : filename;
  return base.split(/[\\/]/).pop()!.trim().slice(0, 120) || 'Untitled concept';
}

function SelectField({ name, label, options, value, onChange, placeholder }: SelectFieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={name}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* Hidden mirror — the shadcn Select isn't a native form element,
          so we relay the value through a hidden input for FormData. */}
      <input type="hidden" name={name} value={value} />
    </div>
  );
}
