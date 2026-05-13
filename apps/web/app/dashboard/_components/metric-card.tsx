import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Props {
  label: string;
  value: string;
  hint?: string;
  emoji?: string;
  tone?: 'neutral' | 'good' | 'bad';
}

/** Phase 6 P&L metric card. Compact, no chrome — color comes from tone. */
export function MetricCard({ label, value, hint, emoji, tone = 'neutral' }: Props) {
  const valueColor =
    tone === 'good' ? 'text-green-700' : tone === 'bad' ? 'text-destructive' : 'text-foreground';
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
          {emoji && <span className="mr-1">{emoji}</span>}
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className={`text-2xl font-bold ${valueColor}`}>{value}</p>
        {hint && <p className="text-muted-foreground mt-1 text-xs">{hint}</p>}
      </CardContent>
    </Card>
  );
}
