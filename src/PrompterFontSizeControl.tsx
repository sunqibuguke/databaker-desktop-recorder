import { useI18n } from './i18n';
import { PROMPTER_FONT_SIZE_STEP } from './prompter-appearance';

export function PrompterFontSizeControl({
  size,
  min,
  max,
  onNudge,
  compact = false,
  caption,
  testId = 'prompter-font-size',
  smallerLabel,
  largerLabel,
}: {
  size: number;
  min: number;
  max: number;
  onNudge: (delta: number) => void;
  compact?: boolean;
  caption?: string;
  testId?: string;
  smallerLabel: string;
  largerLabel: string;
}) {
  const { t } = useI18n();
  return <div className={`prompter-type-size${compact ? ' compact' : ''}`} data-testid={testId}>
    {caption ? <span className="prompter-type-size-caption">{caption}</span> : null}
    <button
      type="button"
      disabled={size <= min}
      title={smallerLabel}
      aria-label={smallerLabel}
      onClick={() => onNudge(-PROMPTER_FONT_SIZE_STEP)}
    >A−</button>
    <output aria-live="polite">{t('prompter.fontSizeValue', { size })}</output>
    <button
      type="button"
      disabled={size >= max}
      title={largerLabel}
      aria-label={largerLabel}
      onClick={() => onNudge(PROMPTER_FONT_SIZE_STEP)}
    >A+</button>
  </div>;
}
